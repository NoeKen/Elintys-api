import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  CreatePaymentInput,
  PaymentHandle,
  PaymentProvider,
  PAYMENT_PROVIDER_TOKENS,
  ProviderPaymentStatus,
} from '../payment-provider.interface';
import { PayPalHttpClient } from './paypal-http.client';
import { PayPalOrdersApi } from './paypal-orders.api';
import { fromPayPalValue } from './paypal-money';
import { PayPalCaptureState, PayPalOrderSnapshot, PayPalOrderState } from './paypal.types';
import { isAllowedHost } from '../../../../shared/utils/host-matching';

export const PAYPAL_APPROVAL_URL_MISSING = 'PAYPAL_APPROVAL_URL_MISSING';

/**
 * Adaptateur PayPal du contrat `PaymentProvider`.
 *
 * PayPal reste un ADAPTATEUR : cette classe ne connaît ni `TicketOrder`, ni
 * `TicketHold`, ni stock, ni admission. Elle traduit dans les deux sens entre
 * l'API Orders v2 et les types agnostiques du domaine.
 *
 * ENVIRONNEMENT
 * -------------
 * L'adaptateur ne sait PAS s'il parle à Sandbox ou à Live : il consomme
 * `http.config`, dont l'hôte API et les hôtes d'approbation sont dérivés de
 * `PAYPAL_ENV` en un seul endroit. Basculer d'un environnement à l'autre ne
 * demande donc aucune modification de ce fichier.
 *
 * SÉMANTIQUE DES ÉTATS
 * --------------------
 * `APPROVED` n'est PAS un paiement. Les fonds ne bougent qu'à la capture.
 * Une commande approuvée reste donc `PENDING` pour le domaine, qui déclenchera
 * `confirmPayment` (capture) côté serveur.
 */
@Injectable()
export class PayPalPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDER_TOKENS.PAYPAL;

  private readonly logger = new Logger(PayPalPaymentProvider.name);

  constructor(
    private readonly http: PayPalHttpClient,
    private readonly orders: PayPalOrdersApi,
  ) {}

  get enabled(): boolean {
    return this.http.enabled;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentHandle> {
    const snapshot = await this.orders.createOrder({
      orderId: input.orderId,
      // Le montant vient EXCLUSIVEMENT du TicketOrder serveur.
      amountMinorUnits: input.amount,
      currency: input.currency,
      description: input.description,
    });

    if (!snapshot.orderId) {
      throw new ServiceUnavailableException(PAYPAL_APPROVAL_URL_MISSING);
    }
    // Sans URL d'approbation, l'acheteur ne peut rien faire : on échoue tôt
    // plutôt que de laisser une commande bloquée en attente.
    // L'URL doit appartenir aux hôtes de l'environnement COURANT : une URL
    // Live reçue en Sandbox (ou l'inverse) signale une confusion de
    // configuration et n'est jamais suivie.
    if (
      !snapshot.approvalUrl ||
      !isTrustedApprovalUrl(snapshot.approvalUrl, this.http.config.approvalHosts)
    ) {
      this.logger.error(
        `PayPal n'a pas fourni de lien d'approbation valide pour l'environnement ${this.http.config.environment}`,
      );
      throw new ServiceUnavailableException(PAYPAL_APPROVAL_URL_MISSING);
    }

    return this.toHandle(snapshot, snapshot.approvalUrl);
  }

  async getPaymentStatus(reference: string): Promise<ProviderPaymentStatus> {
    const snapshot = await this.orders.getOrder(reference);
    return mapSnapshotToStatus(snapshot);
  }

  /**
   * Capture — déclenchée par le SERVEUR après approbation de l'acheteur.
   *
   * Idempotente : `PayPal-Request-Id` garantit qu'un second appel pour la même
   * commande ne produit pas un second débit. Si la commande est déjà capturée,
   * PayPal renvoie l'état existant, que l'on relit.
   */
  async confirmPayment(input: { reference: string; orderId: string }): Promise<PaymentHandle> {
    let snapshot: PayPalOrderSnapshot;
    try {
      snapshot = await this.orders.captureOrder(input.reference, input.orderId);
    } catch (error: unknown) {
      // Une capture refusée par PayPal (commande déjà capturée, non approuvée,
      // expirée…) ne doit pas masquer l'état réel : on relit la commande et
      // on laisse le domaine décider à partir de l'état faisant autorité.
      this.logger.warn(
        `Capture PayPal non aboutie, relecture de l'état (${error instanceof Error ? error.name : 'UNKNOWN_ERROR'})`,
      );
      snapshot = await this.orders.getOrder(input.reference);
    }

    return this.toHandle(snapshot, null);
  }

  /**
   * PayPal ne propose pas d'annulation explicite d'une commande non capturée :
   * elle expire d'elle-même. On relit l'état pour rester observable, sans
   * jamais échouer — l'annulation doit être idempotente.
   */
  async cancelPayment(reference: string): Promise<void> {
    try {
      await this.orders.getOrder(reference);
    } catch {
      // Best-effort : l'autorité de l'annulation est la base Elintys.
    }
  }

  private toHandle(snapshot: PayPalOrderSnapshot, checkoutUrl: string | null): PaymentHandle {
    let settledAmountMinorUnits: number | null = null;
    if (snapshot.amount) {
      try {
        settledAmountMinorUnits = fromPayPalValue(
          snapshot.amount.value,
          snapshot.amount.currencyCode,
        );
      } catch {
        // Montant illisible : on laisse `null`. Le domaine refusera alors la
        // finalisation plutôt que d'honorer un montant non vérifiable.
        settledAmountMinorUnits = null;
      }
    }

    return {
      provider: this.name,
      reference: snapshot.orderId,
      status: mapSnapshotToStatus(snapshot),
      checkoutUrl,
      settlementReference: snapshot.captureId,
      settledAmountMinorUnits,
      settledCurrency: snapshot.amount?.currencyCode ?? null,
    };
  }
}

/**
 * L'URL d'approbation acheteur doit être en HTTPS et appartenir aux hôtes de
 * l'environnement PayPal courant.
 *
 * `isAllowedHost` compare exactement : `paypal.com.attacker.tld` et
 * `fakepaypal.com` sont refusés, et surtout un hôte Sandbox est refusé en
 * configuration Live — `www.sandbox.paypal.com` étant un sous-domaine de
 * `paypal.com`, une comparaison par domaine ne cloisonnerait pas les deux
 * environnements.
 */
export function isTrustedApprovalUrl(value: string, approvalHosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isAllowedHost(url.hostname, approvalHosts);
  } catch {
    return false;
  }
}

/**
 * Traduction conservatrice état PayPal → état domaine.
 *
 * Tout ce qui n'est pas une capture explicitement `COMPLETED` reste `PENDING`
 * ou devient un échec : jamais un succès par défaut.
 */
export function mapSnapshotToStatus(snapshot: PayPalOrderSnapshot): ProviderPaymentStatus {
  if (snapshot.captureState === PayPalCaptureState.COMPLETED) {
    return ProviderPaymentStatus.SUCCEEDED;
  }
  if (
    snapshot.captureState === PayPalCaptureState.DECLINED ||
    snapshot.captureState === PayPalCaptureState.FAILED
  ) {
    return ProviderPaymentStatus.FAILED;
  }
  if (snapshot.state === PayPalOrderState.VOIDED) {
    return ProviderPaymentStatus.CANCELLED;
  }
  // CREATED, PAYER_ACTION_REQUIRED, APPROVED, COMPLETED-sans-capture-lisible,
  // UNKNOWN, capture PENDING ou REFUNDED : le domaine attend ou expire.
  return ProviderPaymentStatus.PENDING;
}
