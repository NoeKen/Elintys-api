import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  buildTestReference,
  computeStatus,
  DELAYED_SUCCESS_DELAY_MS,
  normalizeScenario,
  parseTestReference,
  TEST_PAYMENT_PROVIDER_DISABLED,
  TestPaymentProvider,
  TestPaymentScenario,
} from './test-payment.provider';
import { ProviderPaymentStatus } from './payment-provider.interface';

function buildProvider(enabled: boolean): TestPaymentProvider {
  const config = {
    get: jest.fn().mockReturnValue(enabled),
  } as unknown as ConfigService;
  return new TestPaymentProvider(config);
}

const ORDER_ID = '664f1a2b3c4d5e6f7a8b9c0d';

afterEach(() => jest.clearAllMocks());

describe('TestPaymentProvider — garde de sécurité', () => {
  it.each(['createPayment', 'getPaymentStatus', 'cancelPayment'] as const)(
    'devrait refuser %s lorsque le fournisseur simulé est désactivé',
    async (method) => {
      const provider = buildProvider(false);
      const call =
        method === 'createPayment'
          ? provider.createPayment({
              orderId: ORDER_ID,
              amount: 1000,
              currency: 'cad',
              description: 'test',
              expiresAt: new Date(),
            })
          : method === 'getPaymentStatus'
            ? provider.getPaymentStatus('testpay:SUCCESS:x:1')
            : provider.cancelPayment('testpay:SUCCESS:x:1');

      await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(call).rejects.toThrow(TEST_PAYMENT_PROVIDER_DISABLED);
    },
  );

  it('devrait exposer son état d\'activation', () => {
    expect(buildProvider(true).enabled).toBe(true);
    expect(buildProvider(false).enabled).toBe(false);
  });
});

describe('TestPaymentProvider — création de paiement', () => {
  it('ne devrait jamais exposer d\'URL de paiement (rien ne doit ressembler à un vrai paiement)', async () => {
    const provider = buildProvider(true);
    const handle = await provider.createPayment({
      orderId: ORDER_ID,
      amount: 2500,
      currency: 'cad',
      description: 'Commande Elintys',
      expiresAt: new Date(),
      scenario: TestPaymentScenario.SUCCESS,
    });

    expect(handle.checkoutUrl).toBeNull();
    expect(handle.provider).toBe('test');
    expect(handle.reference).toContain(ORDER_ID);
    expect(handle.status).toBe(ProviderPaymentStatus.SUCCEEDED);
  });

  it('devrait utiliser SUCCESS par défaut lorsque aucun scénario n\'est fourni', async () => {
    const provider = buildProvider(true);
    const handle = await provider.createPayment({
      orderId: ORDER_ID,
      amount: 100,
      currency: 'cad',
      description: 'x',
      expiresAt: new Date(),
    });
    expect(parseTestReference(handle.reference).scenario).toBe(TestPaymentScenario.SUCCESS);
  });

  it('devrait produire des références déterministes et relisibles', () => {
    const reference = buildTestReference(TestPaymentScenario.DECLINED, ORDER_ID, 1_700_000_000_000);
    expect(parseTestReference(reference)).toEqual({
      scenario: TestPaymentScenario.DECLINED,
      orderId: ORDER_ID,
      createdAtMs: 1_700_000_000_000,
    });
  });
});

describe('TestPaymentProvider — scénarios déterministes', () => {
  const createdAt = 1_700_000_000_000;

  it.each([
    [TestPaymentScenario.SUCCESS, ProviderPaymentStatus.SUCCEEDED],
    [TestPaymentScenario.DUPLICATE_CALLBACK, ProviderPaymentStatus.SUCCEEDED],
    [TestPaymentScenario.DECLINED, ProviderPaymentStatus.FAILED],
    [TestPaymentScenario.CANCELLED, ProviderPaymentStatus.CANCELLED],
    [TestPaymentScenario.TIMEOUT, ProviderPaymentStatus.PENDING],
  ])('devrait résoudre %s en %s', (scenario, expected) => {
    const reference = buildTestReference(scenario, ORDER_ID, createdAt);
    expect(computeStatus(reference, createdAt)).toBe(expected);
    // Déterminisme dans le temps : le statut ne dérive pas.
    expect(computeStatus(reference, createdAt + 10 * 60_000)).toBe(expected);
  });

  it('devrait faire basculer DELAYED_SUCCESS uniquement après le délai', () => {
    const reference = buildTestReference(TestPaymentScenario.DELAYED_SUCCESS, ORDER_ID, createdAt);
    expect(computeStatus(reference, createdAt)).toBe(ProviderPaymentStatus.PENDING);
    expect(computeStatus(reference, createdAt + DELAYED_SUCCESS_DELAY_MS - 1)).toBe(
      ProviderPaymentStatus.PENDING,
    );
    expect(computeStatus(reference, createdAt + DELAYED_SUCCESS_DELAY_MS)).toBe(
      ProviderPaymentStatus.SUCCEEDED,
    );
  });

  it('devrait donner le même statut pour deux instances lisant la même référence', async () => {
    const first = buildProvider(true);
    const second = buildProvider(true);
    const reference = buildTestReference(TestPaymentScenario.SUCCESS, ORDER_ID, createdAt);

    expect(await first.getPaymentStatus(reference)).toBe(await second.getPaymentStatus(reference));
  });
});

describe('TestPaymentProvider — références invalides', () => {
  it.each([
    'testpay:SUCCESS:order',
    'other:SUCCESS:order:1',
    'testpay:UNKNOWN:order:1',
    'testpay:SUCCESS::1',
    'testpay:SUCCESS:order:abc',
  ])('devrait refuser la référence %s', (reference) => {
    expect(() => parseTestReference(reference)).toThrow(ServiceUnavailableException);
  });

  it('devrait refuser un scénario inconnu', () => {
    expect(() => normalizeScenario('MAGIC')).toThrow(ServiceUnavailableException);
  });

  it('devrait accepter un scénario connu insensible à la casse', () => {
    expect(normalizeScenario('declined')).toBe(TestPaymentScenario.DECLINED);
  });

  it('devrait annuler de façon idempotente', async () => {
    const provider = buildProvider(true);
    const reference = buildTestReference(TestPaymentScenario.CANCELLED, ORDER_ID, 1);
    await expect(provider.cancelPayment(reference)).resolves.toBeUndefined();
    await expect(provider.cancelPayment(reference)).resolves.toBeUndefined();
  });
});
