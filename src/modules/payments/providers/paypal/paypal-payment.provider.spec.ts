import { ServiceUnavailableException } from '@nestjs/common';
import {
  mapSnapshotToStatus,
  isTrustedSandboxApprovalUrl,
  PAYPAL_APPROVAL_URL_MISSING,
  PAYPAL_LIVE_MODE_REFUSED,
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

function build(environment: 'sandbox' | 'live' = 'sandbox') {
  const orders = {
    createOrder: jest.fn(),
    getOrder: jest.fn(),
    captureOrder: jest.fn(),
  };
  const http = {
    config: { environment, enabled: true },
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

describe('PayPalPaymentProvider — garde Sandbox', () => {
  it.each(['createPayment', 'getPaymentStatus', 'confirmPayment'] as const)(
    'devrait refuser %s en mode live',
    async (method) => {
      const { provider } = build('live');
      const call =
        method === 'createPayment'
          ? provider.createPayment(CREATE_INPUT)
          : method === 'getPaymentStatus'
            ? provider.getPaymentStatus('PP-1')
            : provider.confirmPayment({ reference: 'PP-1', orderId: 'order-1' });
      await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(call).rejects.toThrow(PAYPAL_LIVE_MODE_REFUSED);
    },
  );

  it('ne devrait effectuer aucun appel réseau en mode live', async () => {
    const { provider, orders } = build('live');
    await expect(provider.createPayment(CREATE_INPUT)).rejects.toThrow();
    expect(orders.createOrder).not.toHaveBeenCalled();
  });

  it('devrait rester silencieux et sans effet sur cancelPayment en mode live', async () => {
    const { provider, orders } = build('live');
    await expect(provider.cancelPayment('PP-1')).resolves.toBeUndefined();
    expect(orders.getOrder).not.toHaveBeenCalled();
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

  it('devrait accepter uniquement une URL HTTPS PayPal Sandbox', () => {
    expect(
      isTrustedSandboxApprovalUrl(
        'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1',
      ),
    ).toBe(true);
    expect(isTrustedSandboxApprovalUrl('https://www.paypal.com/checkoutnow')).toBe(false);
    expect(isTrustedSandboxApprovalUrl('http://www.sandbox.paypal.com/checkoutnow')).toBe(false);
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
