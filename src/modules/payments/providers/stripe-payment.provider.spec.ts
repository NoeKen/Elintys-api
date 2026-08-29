import { ConfigService } from '@nestjs/config';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  mapStripeSessionStatus,
  StripeCheckoutClient,
  StripePaymentProvider,
  createStripeCheckoutClient,
} from './stripe-payment.provider';
import { ProviderPaymentStatus } from './payment-provider.interface';
import { ErrorCodes } from '../../../shared/constants/error-codes';

function buildConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
}

function buildClient(): { client: StripeCheckoutClient; sessions: Record<string, jest.Mock> } {
  const sessions = {
    create: jest.fn(),
    retrieve: jest.fn(),
    expire: jest.fn(),
  };
  return { client: { checkout: { sessions } } as unknown as StripeCheckoutClient, sessions };
}

const CONFIG = { frontendUrl: 'https://app.example.ca', 'stripe.secretKey': 'sk_test_x' };

afterEach(() => jest.clearAllMocks());

describe('createStripeCheckoutClient', () => {
  it('devrait retourner null lorsque aucune clé Stripe n\'est configurée', () => {
    expect(createStripeCheckoutClient(buildConfig({}))).toBeNull();
  });
});

describe('StripePaymentProvider — client absent', () => {
  it('devrait signaler Stripe non configuré plutôt que de tenter un appel', async () => {
    const provider = new StripePaymentProvider(buildConfig(CONFIG), null);
    await expect(provider.getPaymentStatus('cs_1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(provider.getPaymentStatus('cs_1')).rejects.toThrow(
      ErrorCodes.STRIPE_NOT_CONFIGURED,
    );
  });
});

describe('StripePaymentProvider — création', () => {
  it('devrait créer une session avec une clé d\'idempotence dérivée de la commande', async () => {
    const { client, sessions } = buildClient();
    sessions.create.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://stripe.example/cs_test_1',
      status: 'open',
      payment_status: 'unpaid',
    });
    const provider = new StripePaymentProvider(buildConfig(CONFIG), client);

    const handle = await provider.createPayment({
      orderId: 'order-1',
      amount: 2500,
      currency: 'cad',
      description: 'Commande Elintys order-1',
      customerEmail: 'acheteur@example.ca',
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    });

    expect(handle).toEqual({
      provider: 'stripe',
      reference: 'cs_test_1',
      status: ProviderPaymentStatus.PENDING,
      checkoutUrl: 'https://stripe.example/cs_test_1',
    });

    const [params, options] = sessions.create.mock.calls[0] as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(options.idempotencyKey).toBe('ticket-order:order-1');
    expect(params.metadata).toEqual({ orderId: 'order-1' });
    expect(params.customer_email).toBe('acheteur@example.ca');
    expect(params.expires_at).toBe(Math.floor(Date.parse('2026-01-01T00:10:00.000Z') / 1000));
  });

  it('ne devrait pas transmettre customer_email lorsque le serveur ne le connaît pas', async () => {
    const { client, sessions } = buildClient();
    sessions.create.mockResolvedValue({ id: 'cs_2', url: null, status: 'open' });
    const provider = new StripePaymentProvider(buildConfig(CONFIG), client);

    await provider.createPayment({
      orderId: 'order-2',
      amount: 100,
      currency: 'cad',
      description: 'x',
      expiresAt: new Date(),
    });

    const [params] = sessions.create.mock.calls[0] as [Record<string, unknown>];
    expect(params).not.toHaveProperty('customer_email');
  });
});

describe('StripePaymentProvider — lecture et annulation', () => {
  it('devrait lire le statut auprès de Stripe', async () => {
    const { client, sessions } = buildClient();
    sessions.retrieve.mockResolvedValue({ id: 'cs_3', status: 'complete', payment_status: 'paid' });
    const provider = new StripePaymentProvider(buildConfig(CONFIG), client);

    await expect(provider.getPaymentStatus('cs_3')).resolves.toBe(
      ProviderPaymentStatus.SUCCEEDED,
    );
    expect(sessions.retrieve).toHaveBeenCalledWith('cs_3');
  });

  it('devrait rester idempotent lorsque Stripe refuse d\'expirer une session', async () => {
    const { client, sessions } = buildClient();
    const secretReference = 'cs_secret_should_not_be_logged';
    sessions.expire.mockRejectedValue(new Error(`No such session: ${secretReference}`));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const provider = new StripePaymentProvider(buildConfig(CONFIG), client);

    await expect(provider.cancelPayment('cs_4')).resolves.toBeUndefined();
    await expect(provider.cancelPayment('cs_4')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('STRIPE_SESSION_EXPIRATION_IGNORED');
    expect(warn.mock.calls.flat().join(' ')).not.toContain(secretReference);
  });
});

describe('mapStripeSessionStatus', () => {
  it.each([
    ['complete', 'paid', ProviderPaymentStatus.SUCCEEDED],
    ['expired', 'unpaid', ProviderPaymentStatus.CANCELLED],
    ['open', 'unpaid', ProviderPaymentStatus.PENDING],
    ['complete', 'unpaid', ProviderPaymentStatus.PENDING],
    [null, null, ProviderPaymentStatus.PENDING],
    ['something-new', 'paid', ProviderPaymentStatus.PENDING],
  ])('devrait traduire (%s, %s) en %s', (status, paymentStatus, expected) => {
    expect(mapStripeSessionStatus(status, paymentStatus)).toBe(expected);
  });
});
