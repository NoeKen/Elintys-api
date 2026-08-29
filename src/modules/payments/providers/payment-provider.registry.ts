import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes } from '../../../shared/constants/error-codes';
import {
  PaymentProvider,
  PaymentProviderName,
  PAYMENT_PROVIDER_TOKENS,
} from './payment-provider.interface';
import { StripePaymentProvider } from './stripe-payment.provider';
import { TestPaymentProvider } from './test-payment.provider';

/**
 * Sélection du fournisseur de paiement — décision SERVEUR uniquement.
 *
 * Le client ne choisit jamais son fournisseur. L'ordre de priorité est :
 *
 *   1. `PAID_CHECKOUT_ENABLED=true`            → Stripe (paiement réel)
 *   2. fournisseur de test autorisé (dev)      → TestPaymentProvider
 *   3. sinon                                   → 503 PAID_CHECKOUT_NOT_READY
 *
 * Conséquence directe : tant que `PAID_CHECKOUT_ENABLED` reste `false`
 * (état de la Vague 5), aucun paiement réel ne peut être déclenché, et hors
 * `ELINTYS_ENV=dev` aucune commande payante ne peut être créée du tout.
 */
@Injectable()
export class PaymentProviderRegistry {
  constructor(
    private readonly configService: ConfigService,
    private readonly testProvider: TestPaymentProvider,
    private readonly stripeProvider: StripePaymentProvider,
  ) {}

  private get paidCheckoutEnabled(): boolean {
    return this.configService.get<boolean>('stripe.checkoutEnabled') === true;
  }

  private get testProviderEnabled(): boolean {
    return this.configService.get<boolean>('ticketing.testPaymentProviderEnabled') === true;
  }

  /** Fournisseur à utiliser pour une NOUVELLE commande. */
  selectForNewOrder(): PaymentProvider {
    if (this.paidCheckoutEnabled) return this.stripeProvider;
    if (this.testProviderEnabled) return this.testProvider;
    throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
  }

  /** Indique si des commandes payantes peuvent être créées maintenant. */
  get paidOrdersAvailable(): boolean {
    return this.paidCheckoutEnabled || this.testProviderEnabled;
  }

  /**
   * Résolution d'une commande EXISTANTE par le nom stocké sur celle-ci.
   *
   * Une commande créée avec le fournisseur de test ne doit jamais pouvoir être
   * réglée par un autre fournisseur, et inversement.
   */
  resolveByName(name: string): PaymentProvider {
    if (name === PAYMENT_PROVIDER_TOKENS.TEST) {
      if (!this.testProviderEnabled) {
        throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
      }
      return this.testProvider;
    }
    if (name === PAYMENT_PROVIDER_TOKENS.STRIPE) {
      if (!this.paidCheckoutEnabled) {
        throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
      }
      return this.stripeProvider;
    }
    throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
  }

  get availableProviderNames(): PaymentProviderName[] {
    const names: PaymentProviderName[] = [];
    if (this.paidCheckoutEnabled) names.push(PAYMENT_PROVIDER_TOKENS.STRIPE);
    if (this.testProviderEnabled) names.push(PAYMENT_PROVIDER_TOKENS.TEST);
    return names;
  }
}
