import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { TestPaymentProvider } from './test-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';
import { PayPalPaymentProvider } from './paypal/paypal-payment.provider';
import { ErrorCodes } from '../../../shared/constants/error-codes';

function buildRegistry(options: {
  paidCheckout: boolean;
  testProvider: boolean;
  paypal?: boolean;
}): {
  registry: PaymentProviderRegistry;
  test: TestPaymentProvider;
  stripe: StripePaymentProvider;
  paypal: PayPalPaymentProvider;
} {
  const values: Record<string, unknown> = {
    'stripe.checkoutEnabled': options.paidCheckout,
    'ticketing.testPaymentProviderEnabled': options.testProvider,
  };
  const config = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  const test = { name: 'test' } as unknown as TestPaymentProvider;
  const stripe = { name: 'stripe' } as unknown as StripePaymentProvider;
  const paypal = {
    name: 'paypal',
    enabled: options.paypal === true,
  } as unknown as PayPalPaymentProvider;
  return {
    registry: new PaymentProviderRegistry(config, test, stripe, paypal),
    test,
    stripe,
    paypal,
  };
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

describe('PaymentProviderRegistry — PayPal (Vague 6)', () => {
  it('devrait choisir PayPal lorsque les DEUX drapeaux sont ouverts', () => {
    const { registry, paypal } = buildRegistry({
      paidCheckout: true,
      testProvider: false,
      paypal: true,
    });
    expect(registry.selectForNewOrder()).toBe(paypal);
    expect(registry.availableProviderNames).toEqual(['paypal', 'stripe']);
  });

  it('devrait ignorer PayPal si PAID_CHECKOUT_ENABLED est fermé', () => {
    const { registry } = buildRegistry({
      paidCheckout: false,
      testProvider: false,
      paypal: true,
    });
    expect(() => registry.selectForNewOrder()).toThrow(ErrorCodes.PAID_CHECKOUT_NOT_READY);
    expect(registry.availableProviderNames).toEqual([]);
  });

  it('devrait retomber sur Stripe si PAYPAL_PROVIDER_ENABLED est fermé', () => {
    const { registry, stripe } = buildRegistry({
      paidCheckout: true,
      testProvider: false,
      paypal: false,
    });
    expect(registry.selectForNewOrder()).toBe(stripe);
  });

  it('devrait donner la priorité au fournisseur de test uniquement en caisse fermée', () => {
    const { registry, test } = buildRegistry({
      paidCheckout: false,
      testProvider: true,
      paypal: true,
    });
    expect(registry.selectForNewOrder()).toBe(test);
  });

  it('devrait refuser de régler une commande PayPal si un drapeau est fermé', () => {
    const closed = buildRegistry({ paidCheckout: false, testProvider: false, paypal: true });
    expect(() => closed.registry.resolveByName('paypal')).toThrow(
      ErrorCodes.PAID_CHECKOUT_NOT_READY,
    );
    const disabled = buildRegistry({ paidCheckout: true, testProvider: false, paypal: false });
    expect(() => disabled.registry.resolveByName('paypal')).toThrow(
      ErrorCodes.PAID_CHECKOUT_NOT_READY,
    );
  });

  it('devrait résoudre PayPal par son nom quand il est autorisé', () => {
    const { registry, paypal } = buildRegistry({
      paidCheckout: true,
      testProvider: false,
      paypal: true,
    });
    expect(registry.resolveByName('paypal')).toBe(paypal);
  });
});
