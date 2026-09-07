import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  backoffMs,
  extractIssue,
  isRetriableStatus,
  PAYPAL_AUTH_FAILED,
  PAYPAL_MAX_ATTEMPTS,
  PAYPAL_NOT_CONFIGURED,
  PAYPAL_UNAVAILABLE,
  PayPalApiError,
  PayPalHttpClient,
} from './paypal-http.client';
import { PAYPAL_DISABLED, resolvePayPalConfig } from '../../../../config/paypal-environment';

/**
 * Configuration résolue par la SOURCE DE VÉRITÉ, pas recopiée à la main :
 * le client HTTP doit consommer exactement ce que la configuration produit.
 */
const ENABLED_CONFIG = resolvePayPalConfig(
  {
    enabled: 'true',
    environment: 'sandbox',
    clientId: 'sb-client',
    clientSecret: 'sb-super-secret',
    webhookId: 'WH-42',
  },
  'dev',
  'development',
);

const LIVE_CONFIG = resolvePayPalConfig(
  {
    enabled: 'true',
    environment: 'live',
    clientId: 'FAKE-live-client-not-a-credential',
    clientSecret: 'FAKE-live-secret-not-a-credential',
    webhookId: 'WH-LIVE',
  },
  'prod',
  'production',
);

function build(config: unknown = ENABLED_CONFIG): PayPalHttpClient {
  const configService = {
    getOrThrow: jest.fn(() => config),
  } as unknown as ConfigService;
  return new PayPalHttpClient(configService);
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => jest.clearAllMocks());

describe('PayPalHttpClient — configuration', () => {
  it('devrait refuser tout appel lorsque PayPal est désactivé', async () => {
    const client = build(PAYPAL_DISABLED);
    expect(client.enabled).toBe(false);
    await expect(client.getAccessToken()).rejects.toThrow(PAYPAL_NOT_CONFIGURED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('devrait exposer le webhookId configuré', () => {
    expect(build().webhookId).toBe('WH-42');
  });
});

describe('PayPalHttpClient — environnement piloté par configuration', () => {
  it.each([
    ['sandbox', ENABLED_CONFIG],
    ['live', LIVE_CONFIG],
  ])('devrait viser l\'hôte API %s sans modification de code', async (_name, config) => {
    // Le MÊME client, la MÊME classe : seule la configuration injectée change.
    const client = build(config);
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: 'tok', expires_in: 32_400 }));

    await client.getAccessToken();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${config.baseUrl}/v1/oauth2/token`);
  });

  it('devrait cloisonner les hôtes API des deux environnements', () => {
    expect(ENABLED_CONFIG.baseUrl).toBe('https://api-m.sandbox.paypal.com');
    expect(LIVE_CONFIG.baseUrl).toBe('https://api-m.paypal.com');
  });

  it('devrait porter un webhook distinct par environnement', () => {
    // Un webhook Sandbox ne doit jamais servir à vérifier une signature Live.
    expect(ENABLED_CONFIG.webhookId).not.toBe(LIVE_CONFIG.webhookId);
  });
});

describe('PayPalHttpClient — OAuth', () => {
  it('devrait envoyer des credentials Basic et mettre le jeton en cache', async () => {
    const client = build();
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: 'tok-1', expires_in: 32_400 }));

    expect(await client.getAccessToken()).toBe('tok-1');
    expect(await client.getAccessToken()).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ENABLED_CONFIG.baseUrl}/v1/oauth2/token`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('sb-client:sb-super-secret').toString('base64')}`,
    );
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('ne devrait faire qu\'un seul aller-retour pour des appels concurrents', async () => {
    const client = build();
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: 'tok-1', expires_in: 32_400 }));

    const tokens = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('devrait redemander un jeton lorsque la durée de vie est trop courte pour la marge', async () => {
    const client = build();
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: 'tok-1', expires_in: 10 }));

    await client.getAccessToken();
    await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('devrait échouer proprement lorsque PayPal refuse les credentials', async () => {
    const client = build();
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'invalid_client' }));
    await expect(client.getAccessToken()).rejects.toThrow(PAYPAL_AUTH_FAILED);
  });

  it('devrait purger le cache sur invalidateToken', async () => {
    const client = build();
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: 'tok-1', expires_in: 32_400 }));
    await client.getAccessToken();
    client.invalidateToken();
    await client.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('PayPalHttpClient — requêtes', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'tok-1', expires_in: 32_400 }),
    );
  });

  it('devrait authentifier et transmettre PayPal-Request-Id', async () => {
    const client = build();
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'PP-1' }));

    const result = await client.request<{ id: string }>({
      method: 'POST',
      path: '/v2/checkout/orders',
      body: { intent: 'CAPTURE' },
      requestId: 'ticket-order-create:order-1',
      prefer: 'return=representation',
    });

    expect(result).toEqual({ id: 'PP-1' });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
    expect(headers['PayPal-Request-Id']).toBe('ticket-order-create:order-1');
    expect(headers.Prefer).toBe('return=representation');
  });

  it('devrait purger le jeton et signaler une erreur retriable sur 401', async () => {
    const client = build();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { name: 'UNAUTHORIZED' }));

    await expect(client.request({ method: 'GET', path: '/v2/checkout/orders/X' })).rejects.toThrow(
      PayPalApiError,
    );
  });

  it('devrait traduire une erreur métier en code stable, sans corps brut', async () => {
    const client = build();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        name: 'UNPROCESSABLE_ENTITY',
        details: [{ issue: 'ORDER_NOT_APPROVED', description: 'compte confidentiel' }],
      }),
    );

    await expect(
      client.request({ method: 'POST', path: '/v2/checkout/orders/X/capture' }),
    ).rejects.toThrow('PAYPAL_API_ERROR:422:ORDER_NOT_APPROVED');
  });

  it('devrait reprendre puis abandonner après le nombre maximal de tentatives', async () => {
    const client = build();
    fetchMock.mockResolvedValue(jsonResponse(503, { name: 'SERVICE_UNAVAILABLE' }));

    await expect(client.request({ method: 'GET', path: '/v2/checkout/orders/X' })).rejects.toThrow(
      PayPalApiError,
    );
    // 1 appel OAuth + PAYPAL_MAX_ATTEMPTS appels métier
    expect(fetchMock).toHaveBeenCalledTimes(1 + PAYPAL_MAX_ATTEMPTS);
  });

  it('devrait signaler PayPal indisponible après épuisement des reprises réseau', async () => {
    const client = build();
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(client.request({ method: 'GET', path: '/v2/checkout/orders/X' })).rejects.toThrow(
      PAYPAL_UNAVAILABLE,
    );
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('Utilitaires', () => {
  it.each([408, 429, 500, 503, 599])('devrait considérer %d comme retriable', (status) => {
    expect(isRetriableStatus(status)).toBe(true);
  });

  it.each([200, 201, 400, 401, 404, 422])('ne devrait pas reprendre sur %d', (status) => {
    expect(isRetriableStatus(status)).toBe(false);
  });

  it('devrait produire un back-off croissant et borné', () => {
    expect(backoffMs(1)).toBe(200);
    expect(backoffMs(2)).toBe(400);
    expect(backoffMs(10)).toBe(2_000);
  });

  it.each([
    [{ details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 'ORDER_NOT_APPROVED'],
    [{ name: 'UNPROCESSABLE_ENTITY' }, 'UNPROCESSABLE_ENTITY'],
    [{ name: 'contient des espaces' }, 'UNKNOWN_ISSUE'],
    [{}, 'UNKNOWN_ISSUE'],
    [null, 'UNKNOWN_ISSUE'],
    ['texte brut', 'UNKNOWN_ISSUE'],
  ])('devrait extraire un code d\'erreur sûr de %p', (payload, expected) => {
    expect(extractIssue(payload)).toBe(expected);
  });
});
