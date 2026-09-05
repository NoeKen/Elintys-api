import {
  isTrustedCertUrl,
  PAYPAL_WEBHOOK_HEADERS,
  PayPalWebhookVerifier,
  WebhookRejectionReason,
} from './paypal-webhook.verifier';
import { PayPalHttpClient } from './paypal-http.client';

const VALID_HEADERS: Record<string, string> = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-abc',
  'paypal-transmission-id': 'trans-1',
  'paypal-transmission-sig': 'signature-blob',
  'paypal-transmission-time': '2026-08-29T12:00:00Z',
};

const EVENT = {
  id: 'WH-EVENT-1',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  create_time: '2026-08-29T12:00:00Z',
  resource: { id: 'CAPTURE-1' },
};

function build(verificationStatus: string | Error = 'SUCCESS') {
  const request = jest.fn().mockImplementation(() =>
    verificationStatus instanceof Error
      ? Promise.reject(verificationStatus)
      : Promise.resolve({ verification_status: verificationStatus }),
  );
  const http = { request, webhookId: 'WH-CONFIGURED' } as unknown as PayPalHttpClient;
  return { verifier: new PayPalWebhookVerifier(http), request };
}

const body = (payload: unknown = EVENT) => Buffer.from(JSON.stringify(payload), 'utf8');

afterEach(() => jest.clearAllMocks());

describe('PayPalWebhookVerifier — webhook authentique', () => {
  it('devrait accepter un webhook vérifié et exposer ses identifiants', async () => {
    const { verifier } = build('SUCCESS');
    const result = await verifier.verify(VALID_HEADERS, body());

    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error('unreachable');
    expect(result.event).toMatchObject({
      eventId: 'WH-EVENT-1',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
    });
    expect(result.event.resource).toEqual({ id: 'CAPTURE-1' });
  });

  it('devrait transmettre le webhook_id CONFIGURÉ, jamais celui du payload', async () => {
    const { verifier, request } = build('SUCCESS');
    await verifier.verify(VALID_HEADERS, body({ ...EVENT, webhook_id: 'WH-ATTACKER' }));

    const call = request.mock.calls[0][0] as { body: Record<string, unknown>; path: string };
    expect(call.body.webhook_id).toBe('WH-CONFIGURED');
    expect(call.path).toBe('/v1/notifications/verify-webhook-signature');
  });

  it('devrait transmettre les cinq en-têtes de transmission', async () => {
    const { verifier, request } = build('SUCCESS');
    await verifier.verify(VALID_HEADERS, body());

    const call = request.mock.calls[0][0] as { body: Record<string, unknown> };
    expect(call.body).toMatchObject({
      auth_algo: VALID_HEADERS['paypal-auth-algo'],
      cert_url: VALID_HEADERS['paypal-cert-url'],
      transmission_id: VALID_HEADERS['paypal-transmission-id'],
      transmission_sig: VALID_HEADERS['paypal-transmission-sig'],
      transmission_time: VALID_HEADERS['paypal-transmission-time'],
    });
  });
});

describe('PayPalWebhookVerifier — rejets', () => {
  it.each(PAYPAL_WEBHOOK_HEADERS)('devrait rejeter si %s est absent', async (missing) => {
    const { verifier, request } = build();
    const headers = { ...VALID_HEADERS };
    delete headers[missing];

    const result = await verifier.verify(headers, body());

    expect(result).toEqual({ verified: false, reason: WebhookRejectionReason.MISSING_HEADERS });
    expect(request).not.toHaveBeenCalled();
  });

  it('devrait rejeter un en-tête vide', async () => {
    const { verifier } = build();
    const result = await verifier.verify(
      { ...VALID_HEADERS, 'paypal-transmission-sig': '   ' },
      body(),
    );
    expect(result).toMatchObject({ reason: WebhookRejectionReason.MISSING_HEADERS });
  });

  it('devrait rejeter un certificat hors domaine PayPal sans appeler PayPal', async () => {
    const { verifier, request } = build();
    const result = await verifier.verify(
      { ...VALID_HEADERS, 'paypal-cert-url': 'https://evil.example.com/cert' },
      body(),
    );
    expect(result).toEqual({ verified: false, reason: WebhookRejectionReason.UNTRUSTED_CERT_URL });
    expect(request).not.toHaveBeenCalled();
  });

  it('devrait rejeter une signature invalide (corps modifié après signature)', async () => {
    const { verifier } = build('FAILURE');
    const result = await verifier.verify(
      VALID_HEADERS,
      body({ ...EVENT, resource: { id: 'CAPTURE-ALTERED' } }),
    );
    expect(result).toEqual({ verified: false, reason: WebhookRejectionReason.VERIFICATION_FAILED });
  });

  it.each([
    ['corps non JSON', Buffer.from('not json', 'utf8')],
    ['événement sans id', body({ event_type: 'PAYMENT.CAPTURE.COMPLETED' })],
    ['événement sans type', body({ id: 'WH-1' })],
  ])('devrait rejeter : %s', async (_name, raw) => {
    const { verifier, request } = build();
    const result = await verifier.verify(VALID_HEADERS, raw);
    expect(result).toMatchObject({ reason: WebhookRejectionReason.MALFORMED_BODY });
    expect(request).not.toHaveBeenCalled();
  });

  it('devrait refuser plutôt que deviner lorsque PayPal est injoignable', async () => {
    const { verifier } = build(new Error('network down'));
    const result = await verifier.verify(VALID_HEADERS, body());
    expect(result).toEqual({
      verified: false,
      reason: WebhookRejectionReason.VERIFICATION_UNAVAILABLE,
    });
  });

  it('devrait rejeter un statut de vérification inattendu', async () => {
    const { verifier } = build('PENDING');
    const result = await verifier.verify(VALID_HEADERS, body());
    expect(result).toMatchObject({ reason: WebhookRejectionReason.VERIFICATION_FAILED });
  });
});

describe('isTrustedCertUrl', () => {
  it.each([
    'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'https://api.paypal.com/v1/notifications/certs/CERT-1',
    'https://paypal.com/cert',
  ])('devrait accepter %s', (url) => {
    expect(isTrustedCertUrl(url)).toBe(true);
  });

  it.each([
    'http://api.paypal.com/cert',
    'https://evil.com/cert',
    'https://paypal.com.evil.com/cert',
    'https://notpaypal.com/cert',
    'pas-une-url',
    '',
  ])('devrait refuser %p', (url) => {
    expect(isTrustedCertUrl(url)).toBe(false);
  });
});
