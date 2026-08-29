import { ConfigService } from '@nestjs/config';
import { PayPalOrdersApi } from './paypal-orders.api';
import { PayPalHttpClient } from './paypal-http.client';
import { PayPalOrderState } from './paypal.types';

function build() {
  const request = jest.fn().mockResolvedValue({
    id: 'PP-ORDER-1',
    status: 'PAYER_ACTION_REQUIRED',
    links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=1' }],
    purchase_units: [{ custom_id: 'order-1', amount: { currency_code: 'CAD', value: '49.95' } }],
  });
  const http = { request } as unknown as PayPalHttpClient;
  const configService = {
    getOrThrow: jest.fn(() => 'https://app.elintys.test'),
  } as unknown as ConfigService;
  return { api: new PayPalOrdersApi(http, configService), request };
}

const INPUT = {
  orderId: 'order-1',
  amountMinorUnits: 4995,
  currency: 'cad',
  description: 'Commande Elintys order-1',
};

afterEach(() => jest.clearAllMocks());

describe('PayPalOrdersApi — création de commande', () => {
  it('devrait utiliser Orders v2 avec intent CAPTURE', async () => {
    const { api, request } = build();
    await api.createOrder(INPUT);

    const call = request.mock.calls[0][0] as { method: string; path: string; body: Record<string, unknown> };
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v2/checkout/orders');
    expect(call.body.intent).toBe('CAPTURE');
  });

  it('devrait convertir le montant du domaine en format PayPal', async () => {
    const { api, request } = build();
    await api.createOrder(INPUT);

    const body = request.mock.calls[0][0].body as { purchase_units: Record<string, unknown>[] };
    expect(body.purchase_units[0].amount).toEqual({ currency_code: 'CAD', value: '49.95' });
  });

  it('devrait corréler la commande sans en faire l\'autorité', async () => {
    const { api, request } = build();
    await api.createOrder(INPUT);

    const unit = (request.mock.calls[0][0].body as { purchase_units: Record<string, unknown>[] })
      .purchase_units[0];
    expect(unit.reference_id).toBe('order-1');
    expect(unit.custom_id).toBe('order-1');
    // invoice_id : protection fournisseur contre un second paiement de la commande.
    expect(unit.invoice_id).toBe('order-1');
  });

  it('devrait rendre la création idempotente côté fournisseur', async () => {
    const { api, request } = build();
    await api.createOrder(INPUT);
    expect(request.mock.calls[0][0].requestId).toBe('ticket-order-create:order-1');
  });

  it('devrait pointer les URL de retour vers Elintys, jamais vers PayPal', async () => {
    const { api, request } = build();
    await api.createOrder(INPUT);

    const source = (request.mock.calls[0][0].body as {
      payment_source: { paypal: { experience_context: Record<string, string> } };
    }).payment_source.paypal.experience_context;

    expect(source.return_url).toBe('https://app.elintys.test/paiement/succes?order_id=order-1');
    expect(source.cancel_url).toBe('https://app.elintys.test/paiement/annule?order_id=order-1');
    expect(source.user_action).toBe('PAY_NOW');
    expect(source.shipping_preference).toBe('NO_SHIPPING');
  });

  it('devrait tronquer une description trop longue plutôt qu\'échouer', async () => {
    const { api, request } = build();
    await api.createOrder({ ...INPUT, description: 'x'.repeat(300) });

    const unit = (request.mock.calls[0][0].body as { purchase_units: Record<string, unknown>[] })
      .purchase_units[0];
    expect((unit.description as string).length).toBe(127);
  });

  it('devrait traduire la réponse en snapshot interne', async () => {
    const { api } = build();
    const snapshot = await api.createOrder(INPUT);

    expect(snapshot).toMatchObject({
      orderId: 'PP-ORDER-1',
      state: PayPalOrderState.PAYER_ACTION_REQUIRED,
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=1',
      customId: 'order-1',
    });
  });
});

describe('PayPalOrdersApi — lecture et capture', () => {
  it('devrait lire une commande par son identifiant encodé', async () => {
    const { api, request } = build();
    await api.getOrder('PP/ORDER 1');

    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/v2/checkout/orders/PP%2FORDER%201',
    });
  });

  it('devrait capturer avec une clé d\'idempotence dérivée de la commande Elintys', async () => {
    const { api, request } = build();
    await api.captureOrder('PP-ORDER-1', 'order-1');

    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/v2/checkout/orders/PP-ORDER-1/capture',
      requestId: 'ticket-order-capture:order-1',
      prefer: 'return=representation',
    });
  });

  it('ne devrait transmettre aucun montant à la capture — PayPal fait foi', async () => {
    const { api, request } = build();
    await api.captureOrder('PP-ORDER-1', 'order-1');
    expect(request.mock.calls[0][0].body).toEqual({});
  });
});
