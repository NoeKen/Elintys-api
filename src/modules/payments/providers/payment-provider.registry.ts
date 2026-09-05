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
import { PayPalPaymentProvider } from './paypal/paypal-payment.provider';

/**
 * Sélection du fournisseur de paiement — décision SERVEUR uniquement.
 *
 * Le client ne choisit jamais son fournisseur. L'ordre de priorité est :
 *
 *   1. `PAID_CHECKOUT_ENABLED` ET `PAYPAL_PROVIDER_ENABLED` → PayPal
 *   2. `PAID_CHECKOUT_ENABLED=true` seul                    → Stripe
 *   3. fournisseur de test autorisé (dev)                   → TestPaymentProvider
 *   4. sinon                                                → 503 PAID_CHECKOUT_NOT_READY
 *
 * DOUBLE INTERRUPTEUR (Vague 6) : PayPal exige les DEUX drapeaux. Fermer
 * `PAID_CHECKOUT_ENABLED` suffit à couper tout encaissement réel, quel que
 * soit l'état de `PAYPAL_PROVIDER_ENABLED`. Le serveur fait autorité : une UI
 * ouverte par erreur ne peut pas contourner ce refus.
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
    private readonly paypalProvider: PayPalPaymentProvider,
  ) {}

  private get paidCheckoutEnabled(): boolean {
    return this.configService.get<boolean>('stripe.checkoutEnabled') === true;
  }

  private get testProviderEnabled(): boolean {
    return this.configService.get<boolean>('ticketing.testPaymentProviderEnabled') === true;
  }

  /** PayPal exige le drapeau global de caisse ET son propre drapeau. */
  private get paypalEnabled(): boolean {
    return this.paidCheckoutEnabled && this.paypalProvider.enabled;
  }

  /** Fournisseur à utiliser pour une NOUVELLE commande. */
  selectForNewOrder(): PaymentProvider {
    if (this.paypalEnabled) return this.paypalProvider;
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
    if (name === PAYMENT_PROVIDER_TOKENS.PAYPAL) {
      if (!this.paypalEnabled) {
        throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
      }
      return this.paypalProvider;
    }
    throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
  }

  get availableProviderNames(): PaymentProviderName[] {
    const names: PaymentProviderName[] = [];
    if (this.paypalEnabled) names.push(PAYMENT_PROVIDER_TOKENS.PAYPAL);
    if (this.paidCheckoutEnabled) names.push(PAYMENT_PROVIDER_TOKENS.STRIPE);
    if (this.testProviderEnabled) names.push(PAYMENT_PROVIDER_TOKENS.TEST);
    return names;
  }
}
