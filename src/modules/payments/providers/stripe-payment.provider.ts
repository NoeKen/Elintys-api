import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { ErrorCodes } from '../../../shared/constants/error-codes';
import {
  CreatePaymentInput,
  PaymentHandle,
  PaymentProvider,
  PAYMENT_PROVIDER_TOKENS,
  ProviderPaymentStatus,
} from './payment-provider.interface';

/**
 * Sous-ensemble du SDK Stripe réellement utilisé par cet adaptateur.
 * Permet de tester l'adaptateur sans dépendre du client Stripe complet.
 */
export interface StripeCheckoutSessionsApi {
  create(
    params: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ): Promise<{ id: string; url?: string | null; status?: string | null; payment_status?: string | null }>;
  retrieve(
    id: string,
  ): Promise<{ id: string; status?: string | null; payment_status?: string | null }>;
  expire(id: string): Promise<unknown>;
}

export interface StripeCheckoutClient {
  checkout: { sessions: StripeCheckoutSessionsApi };
}

/** Jeton d'injection du client Stripe. Vaut `null` si aucune clé n'est configurée. */
export const STRIPE_CHECKOUT_CLIENT = 'STRIPE_CHECKOUT_CLIENT';

/** Fabrique du client Stripe réel — seul endroit du module qui instancie le SDK. */
export function createStripeCheckoutClient(
  configService: ConfigService,
): StripeCheckoutClient | null {
  const secretKey = configService.get<string>('stripe.secretKey');
  if (!secretKey) return null;
  return new Stripe(secretKey, {
    apiVersion: '2026-04-22.dahlia',
  }) as unknown as StripeCheckoutClient;
}

/**
 * Adaptateur Stripe du contrat PaymentProvider.
 *
 * IMPORTANT — Vague 5 :
 * Cet adaptateur n'est JAMAIS sélectionné tant que `PAID_CHECKOUT_ENABLED`
 * n'est pas `true` (cf. PaymentProviderRegistry). Aucun paiement réel n'est
 * effectué par cette vague. Le chemin Stripe historique
 * (`PaymentsService.createCheckoutSession` + webhook) reste intact et
 * indépendant : il n'est pas réécrit ici, pour ne provoquer aucune régression.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDER_TOKENS.STRIPE;

  private readonly logger = new Logger(StripePaymentProvider.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(STRIPE_CHECKOUT_CLIENT)
    private readonly client: StripeCheckoutClient | null,
  ) {}

  private get sessions(): StripeCheckoutSessionsApi {
    if (!this.client) {
      throw new ServiceUnavailableException(ErrorCodes.STRIPE_NOT_CONFIGURED);
    }
    return this.client.checkout.sessions;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentHandle> {
    const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');
    const session = await this.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        line_items: [
          {
            price_data: {
              currency: input.currency,
              product_data: { name: input.description },
              unit_amount: input.amount,
            },
            quantity: 1,
          },
        ],
        // L'identité de la commande fait autorité côté Elintys, jamais l'inverse.
        metadata: { orderId: input.orderId },
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: `${frontendUrl}/paiement/succes?order_id=${input.orderId}`,
        cancel_url: `${frontendUrl}/paiement/annule?order_id=${input.orderId}`,
      },
      // Une commande = une session Stripe, même si l'appel est rejoué.
      { idempotencyKey: `ticket-order:${input.orderId}` },
    );

    return {
      provider: this.name,
      reference: session.id,
      status: mapStripeSessionStatus(session.status, session.payment_status),
      checkoutUrl: session.url ?? null,
    };
  }

  async getPaymentStatus(reference: string): Promise<ProviderPaymentStatus> {
    const session = await this.sessions.retrieve(reference);
    return mapStripeSessionStatus(session.status, session.payment_status);
  }

  async cancelPayment(reference: string): Promise<void> {
    try {
      await this.sessions.expire(reference);
    } catch {
      // Une session déjà expirée ou déjà complétée n'est pas une erreur métier :
      // l'annulation doit rester idempotente. Les messages SDK peuvent contenir
      // une référence Stripe brute : on journalise donc uniquement un code stable.
      this.logger.warn('STRIPE_SESSION_EXPIRATION_IGNORED');
    }
  }
}

/**
 * Traduction conservatrice des états Stripe Checkout.
 *
 * Toute combinaison inconnue est traitée comme PENDING : le domaine préfère
 * laisser la commande expirer plutôt que de créer une admission à tort.
 */
export function mapStripeSessionStatus(
  status: string | null | undefined,
  paymentStatus: string | null | undefined,
): ProviderPaymentStatus {
  if (status === 'complete' && paymentStatus === 'paid') {
    return ProviderPaymentStatus.SUCCEEDED;
  }
  if (status === 'expired') {
    return ProviderPaymentStatus.CANCELLED;
  }
  return ProviderPaymentStatus.PENDING;
}
