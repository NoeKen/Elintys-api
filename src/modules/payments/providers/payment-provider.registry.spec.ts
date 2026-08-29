import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { TestPaymentProvider } from './test-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';
import { ErrorCodes } from '../../../shared/constants/error-codes';

function buildRegistry(options: { paidCheckout: boolean; testProvider: boolean }): {
  registry: PaymentProviderRegistry;
  test: TestPaymentProvider;
  stripe: StripePaymentProvider;
} {
  const values: Record<string, unknown> = {
    'stripe.checkoutEnabled': options.paidCheckout,
    'ticketing.testPaymentProviderEnabled': options.testProvider,
  };
  const config = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  const test = { name: 'test' } as unknown as TestPaymentProvider;
  const stripe = { name: 'stripe' } as unknown as StripePaymentProvider;
  return { registry: new PaymentProviderRegistry(config, test, stripe), test, stripe };
}

afterEach(() => jest.clearAllMocks());

describe('PaymentProviderRegistry — sélection pour une nouvelle commande', () => {
  it('devrait refuser toute commande payante quand rien n\'est activé', () => {
    const { registry } = buildRegistry({ paidCheckout: false, testProvider: false });
    expect(() => registry.selectForNewOrder()).toThrow(ServiceUnavailableException);
    expect(() => registry.selectForNewOrder()).toThrow(ErrorCodes.PAID_CHECKOUT_NOT_READY);
    expect(registry.paidOrdersAvailable).toBe(false);
    expect(registry.availableProviderNames).toEqual([]);
  });

  it('devrait choisir le fournisseur simulé en dev lorsque le paiement réel est fermé', () => {
    const { registry, test } = buildRegistry({ paidCheckout: false, testProvider: true });
    expect(registry.selectForNewOrder()).toBe(test);
    expect(registry.availableProviderNames).toEqual(['test']);
  });

  it('devrait donner la priorité à Stripe dès que le paiement réel est ouvert', () => {
    const { registry, stripe } = buildRegistry({ paidCheckout: true, testProvider: true });
    expect(registry.selectForNewOrder()).toBe(stripe);
    expect(registry.availableProviderNames).toEqual(['stripe', 'test']);
  });
});

describe('PaymentProviderRegistry — résolution d\'une commande existante', () => {
  it('devrait résoudre chaque fournisseur autorisé par son nom', () => {
    const { registry, test, stripe } = buildRegistry({ paidCheckout: true, testProvider: true });
    expect(registry.resolveByName('test')).toBe(test);
    expect(registry.resolveByName('stripe')).toBe(stripe);
  });

  it('devrait refuser de régler une commande de test quand le simulateur est coupé', () => {
    const { registry } = buildRegistry({ paidCheckout: true, testProvider: false });
    expect(() => registry.resolveByName('test')).toThrow(ErrorCodes.PAID_CHECKOUT_NOT_READY);
  });

  it('devrait refuser de régler une commande Stripe quand le paiement réel est fermé', () => {
    const { registry } = buildRegistry({ paidCheckout: false, testProvider: true });
    expect(() => registry.resolveByName('stripe')).toThrow(ErrorCodes.PAID_CHECKOUT_NOT_READY);
  });

  it.each(['', 'paypal', 'TEST'])('devrait refuser le fournisseur inconnu %p', (name) => {
    const { registry } = buildRegistry({ paidCheckout: true, testProvider: true });
    expect(() => registry.resolveByName(name)).toThrow(ServiceUnavailableException);
  });
});
