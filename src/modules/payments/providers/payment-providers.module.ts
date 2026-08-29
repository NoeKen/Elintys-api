import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderRegistry } from './payment-provider.registry';
import {
  createStripeCheckoutClient,
  STRIPE_CHECKOUT_CLIENT,
  StripePaymentProvider,
} from './stripe-payment.provider';
import { TestPaymentProvider } from './test-payment.provider';
import { PayPalHttpClient } from './paypal/paypal-http.client';
import { PayPalOrdersApi } from './paypal/paypal-orders.api';
import { PayPalPaymentProvider } from './paypal/paypal-payment.provider';
import { PayPalWebhookVerifier } from './paypal/paypal-webhook.verifier';

/**
 * Module d'adaptateurs de paiement.
 *
 * Il ne dépend d'AUCUN module métier : c'est ce qui permet au domaine Ticketing
 * de l'importer sans créer de cycle avec PaymentsModule (qui, lui, dépend de
 * TicketsModule pour le chemin Stripe historique).
 */
@Module({
  providers: [
    {
      provide: STRIPE_CHECKOUT_CLIENT,
      inject: [ConfigService],
      useFactory: createStripeCheckoutClient,
    },
    TestPaymentProvider,
    StripePaymentProvider,
    PayPalHttpClient,
    PayPalOrdersApi,
    PayPalPaymentProvider,
    PayPalWebhookVerifier,
    PaymentProviderRegistry,
  ],
  exports: [
    PaymentProviderRegistry,
    TestPaymentProvider,
    StripePaymentProvider,
    PayPalPaymentProvider,
    PayPalWebhookVerifier,
  ],
})
export class PaymentProvidersModule {}
