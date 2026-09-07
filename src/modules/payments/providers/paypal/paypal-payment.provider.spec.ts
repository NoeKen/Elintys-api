import { ServiceUnavailableException } from '@nestjs/common';
import {
  mapSnapshotToStatus,
  isTrustedApprovalUrl,
  PAYPAL_APPROVAL_URL_MISSING,
  PayPalPaymentProvider,
} from './paypal-payment.provider';
import { PayPalHttpClient } from './paypal-http.client';
import { PayPalOrdersApi } from './paypal-orders.api';
import { ProviderPaymentStatus } from '../payment-provider.interface';
import { PayPalCaptureState, PayPalOrderSnapshot, PayPalOrderState } from './paypal.types';

function snapshot(overrides: Partial<PayPalOrderSnapshot> = {}): PayPalOrderSnapshot {
  return {
    orderId: 'PP-ORDER-1',
    state: PayPalOrderState.CREATED,
    approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1',
    captureId: null,
    captureState: null,
    amount: null,
    customId: 'order-1',
    ...overrides,
  };
}

const APPROVAL_HOSTS = {
  sandbox: ['sandbox.paypal.com', 'www.sandbox.paypal.com'],
  live: ['paypal.com', 'www.paypal.com'],
} as const;

function build(environment: 'sandbox' | 'live' = 'sandbox') {
  const orders = {
    createOrder: jest.fn(),
    getOrder: jest.fn(),
    captureOrder: jest.fn(),
  };
  const http = {
    // L'adaptateur ne lit que `config` : il ne sait pas quel environnement
    // l'opérateur a choisi, il applique celui qu'on lui donne.
    config: { environment, enabled: true, approvalHosts: APPROVAL_HOSTS[environment] },
    enabled: true,
  } as unknown as PayPalHttpClient;
  return {
    provider: new PayPalPaymentProvider(http, orders as unknown as PayPalOrdersApi),
    orders,
  };
}

const CREATE_INPUT = {
  orderId: 'order-1',
  amount: 4995,
  currency: 'cad' as const,
  description: 'Commande Elintys order-1',
  expiresAt: new Date('2026-01-01T00:15:00.000Z'),
};

afterEach(() => jest.clearAllMocks());

describe('PayPalPaymentProvider — indépendance vis-à-vis de l\'environnement', () => {
  it('devrait fonctionner à l\'identique en live, avec les hôtes live', async () => {
    // Preuve d'architecture : le MÊME adaptateur, sans modification, sert les
    // deux environnements. Seule la configuration injectée diffère.
    const { provider, orders } = build('live');
    orders.createOrder.mockResolvedValue(
      snapshot({ approvalUrl: 'https://www.paypal.com/checkoutnow?token=PP-ORDER-1' }),
    );

    const handle = await provider.createPayment(CREATE_INPUT);

    expect(handle.checkoutUrl).toBe('https://www.paypal.com/checkoutnow?token=PP-ORDER-1');
  });

  it('devrait refuser une URL SANDBOX reçue en configuration live', async () => {
    // Une confusion d'environnement est un incident : on ne suit jamais un
    // lien qui n'appartient pas à l'environnement configuré.
    const { provider, orders } = build('live');
    orders.createOrder.mockResolvedValue(
      snapshot({ approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=X' }),
    );

    await expect(provider.createPayment(CREATE_INPUT)).rejects.toThrow(
      PAYPAL_APPROVAL_URL_MISSING,
    );
  });

  it('devrait annuler en best-effort quel que soit l\'environnement', async () => {
    const { provider, orders } = build('live');
    orders.getOrder.mockResolvedValue(snapshot());

    await expect(provider.cancelPayment('PP-1')).resolves.toBeUndefined();
    expect(orders.getOrder).toHaveBeenCalledWith('PP-1');
  });
});

describe('PayPalPaymentProvider — création', () => {
  it('devrait transmettre le montant du domaine et exposer l\'URL d\'approbation', async () => {
    const { provider, orders } = build();
    orders.createOrder.mockResolvedValue(snapshot());

    const handle = await provider.createPayment(CREATE_INPUT);

    expect(orders.createOrder).toHaveBeenCalledWith({
      orderId: 'order-1',
      amountMinorUnits: 4995,
      currency: 'cad',
      description: 'Commande Elintys order-1',
    });
    expect(handle).toMatchObject({
      provider: 'paypal',
      reference: 'PP-ORDER-1',
      status: ProviderPaymentStatus.PENDING,
      checkoutUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1',
    });
  });

  it.each([
    ['sans identifiant', snapshot({ orderId: '' })],
    ['sans lien d\'approbation', snapshot({ approvalUrl: null })],
    [
      'avec lien live',
      snapshot({ approvalUrl: 'https://www.paypal.com/checkoutnow?token=PP-ORDER-1' }),
    ],
    ['avec lien tiers', snapshot({ approvalUrl: 'https://evil.example/checkout' })],
  ])('devrait échouer tôt : commande %s', async (_name, value) => {
    const { provider, orders } = build();
    orders.createOrder.mockResolvedValue(value);
    await expect(provider.createPayment(CREATE_INPUT)).rejects.toThrow(PAYPAL_APPROVAL_URL_MISSING);
  });

  describe('isTrustedApprovalUrl', () => {
    it('devrait accepter une URL HTTPS de l\'environnement configuré', () => {
      expect(
        isTrustedApprovalUrl(
          'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1',
          APPROVAL_HOSTS.sandbox,
        ),
      ).toBe(true);
      expect(
        isTrustedApprovalUrl('https://www.paypal.com/checkoutnow', APPROVAL_HOSTS.live),
      ).toBe(true);
    });

    it('devrait cloisonner sandbox et live', () => {
      expect(
        isTrustedApprovalUrl('https://www.paypal.com/checkoutnow', APPROVAL_HOSTS.sandbox),
      ).toBe(false);
      expect(
        isTrustedApprovalUrl('https://www.sandbox.paypal.com/checkoutnow', APPROVAL_HOSTS.live),
      ).toBe(false);
    });

    it.each([
      ['http', 'http://www.sandbox.paypal.com/checkoutnow'],
      ['javascript', 'javascript:alert(1)'],
      ['data', 'data:text/html,<script>alert(1)</script>'],
      ['domaine sosie', 'https://www.sandbox.paypal.com.attacker.tld/checkoutnow'],
      ['préfixe trompeur', 'https://fakepaypal.com/checkoutnow'],
      ['url invalide', 'pas-une-url'],
    ])('devrait refuser une URL %s', (_name, value) => {
      expect(isTrustedApprovalUrl(value, APPROVAL_HOSTS.sandbox)).toBe(false);
    });
  });
});

describe('PayPalPaymentProvider — capture', () => {
  it('devrait rapporter la capture, son montant et sa devise', async () => {
    const { provider, orders } = build();
    orders.captureOrder.mockResolvedValue(
      snapshot({
        state: PayPalOrderState.COMPLETED,
        approvalUrl: null,
        captureId: 'CAPTURE-7',
        captureState: PayPalCaptureState.COMPLETED,
        amount: { currencyCode: 'CAD', value: '49.95' },
      }),
    );

    const handle = await provider.confirmPayment({ reference: 'PP-ORDER-1', orderId: 'order-1' });

    expect(orders.captureOrder).toHaveBeenCalledWith('PP-ORDER-1', 'order-1');
    expect(handle).toMatchObject({
      status: ProviderPaymentStatus.SUCCEEDED,
      settlementReference: 'CAPTURE-7',
      settledAmountMinorUnits: 4995,
      settledCurrency: 'CAD',
    });
    expect(handle.checkoutUrl).toBeNull();
  });

  it('devrait relire l\'état lorsque la capture est refusée par PayPal', async () => {
    const { provider, orders } = build();
    orders.captureOrder.mockRejectedValue(new Error('ORDER_NOT_APPROVED'));
    orders.getOrder.mockResolvedValue(snapshot({ state: PayPalOrderState.APPROVED }));

    const handle = await provider.confirmPayment({ reference: 'PP-ORDER-1', orderId: 'order-1' });

    expect(orders.getOrder).toHaveBeenCalledWith('PP-ORDER-1');
    expect(handle.status).toBe(ProviderPaymentStatus.PENDING);
  });

  it('ne devrait pas rapporter de montant lorsqu\'il est illisible', async () => {
    const { provider, orders } = build();
    orders.captureOrder.mockResolvedValue(
      snapshot({
        captureId: 'C-1',
        captureState: PayPalCaptureState.COMPLETED,
        amount: { currencyCode: 'CAD', value: 'not-a-number' },
      }),
    );
    const handle = await provider.confirmPayment({ reference: 'PP-ORDER-1', orderId: 'order-1' });
    expect(handle.settledAmountMinorUnits).toBeNull();
  });
});

describe('mapSnapshotToStatus — traduction conservatrice', () => {
  it.each([
    ['capture COMPLETED', { captureState: PayPalCaptureState.COMPLETED }, ProviderPaymentStatus.SUCCEEDED],
    ['capture DECLINED', { captureState: PayPalCaptureState.DECLINED }, ProviderPaymentStatus.FAILED],
    ['capture FAILED', { captureState: PayPalCaptureState.FAILED }, ProviderPaymentStatus.FAILED],
    ['commande VOIDED', { state: PayPalOrderState.VOIDED }, ProviderPaymentStatus.CANCELLED],
    ['commande APPROVED sans capture', { state: PayPalOrderState.APPROVED }, ProviderPaymentStatus.PENDING],
    ['commande CREATED', { state: PayPalOrderState.CREATED }, ProviderPaymentStatus.PENDING],
    ['état inconnu', { state: PayPalOrderState.UNKNOWN }, ProviderPaymentStatus.PENDING],
    ['capture PENDING', { captureState: PayPalCaptureState.PENDING }, ProviderPaymentStatus.PENDING],
    ['capture REFUNDED', { captureState: PayPalCaptureState.REFUNDED }, ProviderPaymentStatus.PENDING],
  ])('devrait traduire %s', (_name, overrides, expected) => {
    expect(mapSnapshotToStatus(snapshot(overrides))).toBe(expected);
  });

  it('APPROVED ne doit JAMAIS valoir payé — les fonds ne bougent qu\'à la capture', () => {
    expect(mapSnapshotToStatus(snapshot({ state: PayPalOrderState.APPROVED }))).not.toBe(
      ProviderPaymentStatus.SUCCEEDED,
    );
  });
});
