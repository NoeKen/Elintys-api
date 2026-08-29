import {
  PayPalCaptureState,
  PayPalOrderState,
  toCaptureState,
  toOrderState,
  translateOrder,
} from './paypal.types';

describe('toOrderState / toCaptureState', () => {
  it.each([
    ['CREATED', PayPalOrderState.CREATED],
    ['approved', PayPalOrderState.APPROVED],
    ['COMPLETED', PayPalOrderState.COMPLETED],
    ['VOIDED', PayPalOrderState.VOIDED],
  ])('devrait normaliser l\'état de commande %s', (raw, expected) => {
    expect(toOrderState(raw)).toBe(expected);
  });

  it.each([undefined, null, 42, 'SOMETHING_NEW', ''])(
    'devrait retomber sur UNKNOWN pour %p',
    (raw) => {
      expect(toOrderState(raw)).toBe(PayPalOrderState.UNKNOWN);
      expect(toCaptureState(raw)).toBe(PayPalCaptureState.UNKNOWN);
    },
  );
});

describe('translateOrder', () => {
  it('devrait extraire le lien d\'approbation d\'une commande créée', () => {
    const snapshot = translateOrder({
      id: '5O190127TN364715T',
      status: 'PAYER_ACTION_REQUIRED',
      links: [
        { rel: 'self', href: 'https://api/x' },
        { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O1' },
      ],
      purchase_units: [{ custom_id: 'order-1', amount: { currency_code: 'CAD', value: '49.95' } }],
    });

    expect(snapshot).toMatchObject({
      orderId: '5O190127TN364715T',
      state: PayPalOrderState.PAYER_ACTION_REQUIRED,
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O1',
      captureId: null,
      customId: 'order-1',
    });
    expect(snapshot.amount).toEqual({ currencyCode: 'CAD', value: '49.95' });
  });

  it('devrait accepter le rel legacy « approve »', () => {
    const snapshot = translateOrder({
      id: 'X',
      status: 'CREATED',
      links: [{ rel: 'approve', href: 'https://paypal/approve' }],
    });
    expect(snapshot.approvalUrl).toBe('https://paypal/approve');
  });

  it('devrait extraire la capture d\'une commande complétée', () => {
    const snapshot = translateOrder({
      id: 'ORDER-9',
      status: 'COMPLETED',
      purchase_units: [
        {
          custom_id: 'order-9',
          payments: {
            captures: [
              { id: 'CAPTURE-1', status: 'COMPLETED', amount: { currency_code: 'CAD', value: '10.00' } },
            ],
          },
        },
      ],
    });

    expect(snapshot).toMatchObject({
      orderId: 'ORDER-9',
      state: PayPalOrderState.COMPLETED,
      captureId: 'CAPTURE-1',
      captureState: PayPalCaptureState.COMPLETED,
      approvalUrl: null,
    });
    expect(snapshot.amount).toEqual({ currencyCode: 'CAD', value: '10.00' });
  });

  it.each([
    ['objet vide', {}],
    ['champs de mauvais type', { id: 42, status: {}, links: 'nope', purchase_units: 7 }],
    ['unités vides', { id: 'A', status: 'CREATED', purchase_units: [] }],
  ])('devrait rester tolérant : %s', (_name, raw) => {
    const snapshot = translateOrder(raw as never);
    expect(snapshot.captureId).toBeNull();
    expect(snapshot.amount).toBeNull();
    expect(snapshot.approvalUrl).toBeNull();
  });

  it('ne devrait jamais déduire un succès depuis un état inconnu', () => {
    const snapshot = translateOrder({ id: 'A', status: 'SOMETHING_NEW' });
    expect(snapshot.state).toBe(PayPalOrderState.UNKNOWN);
    expect(snapshot.captureState).toBeNull();
  });
});
