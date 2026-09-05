import {
  describePayPalConfig,
  PAYPAL_SANDBOX_BASE_URL,
  resolvePayPalConfig,
} from './paypal-environment';

const CREDS = {
  clientId: 'sb-client-id',
  clientSecret: 'sb-secret',
  webhookId: 'WH-123',
};

afterEach(() => jest.clearAllMocks());

describe('resolvePayPalConfig — désactivé', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])(
    'devrait rester désactivé lorsque PAYPAL_PROVIDER_ENABLED vaut %p',
    (enabled) => {
      const config = resolvePayPalConfig(
        { enabled, environment: 'sandbox', ...CREDS },
        'dev',
        'development',
      );
      expect(config.enabled).toBe(false);
      expect(config.clientId).toBeNull();
      expect(config.clientSecret).toBeNull();
    },
  );
});

describe('resolvePayPalConfig — sandbox', () => {
  it('devrait activer le fournisseur avec des credentials complètes', () => {
    const config = resolvePayPalConfig(
      { enabled: 'true', environment: 'sandbox', ...CREDS },
      'dev',
      'development',
    );
    expect(config).toMatchObject({
      enabled: true,
      environment: 'sandbox',
      baseUrl: PAYPAL_SANDBOX_BASE_URL,
    });
  });

  it('devrait utiliser sandbox par défaut lorsque PAYPAL_ENV est absent', () => {
    const config = resolvePayPalConfig(
      { enabled: 'true', environment: undefined, ...CREDS },
      'dev',
      'development',
    );
    expect(config.environment).toBe('sandbox');
    expect(config.baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
  });

  it.each([
    ['PAYPAL_CLIENT_ID', { ...CREDS, clientId: '  ' }],
    ['PAYPAL_CLIENT_SECRET', { ...CREDS, clientSecret: undefined }],
    ['PAYPAL_WEBHOOK_ID', { ...CREDS, webhookId: '' }],
  ])('devrait refuser de démarrer sans %s', (name, creds) => {
    expect(() =>
      resolvePayPalConfig({ enabled: 'true', environment: 'sandbox', ...creds }, 'dev', 'development'),
    ).toThrow(name);
  });

  it('devrait rejeter une valeur PAYPAL_ENV inconnue', () => {
    expect(() =>
      resolvePayPalConfig(
        { enabled: 'true', environment: 'staging', ...CREDS },
        'dev',
        'development',
      ),
    ).toThrow('PAYPAL_ENV');
  });
});

describe('resolvePayPalConfig — refus absolu du mode live', () => {
  it.each([
    ['dev', 'development'],
    ['dev', 'production'],
    ['prod', 'development'],
  ])('devrait refuser live avec ELINTYS_ENV=%s et NODE_ENV=%s', (elintysEnv, nodeEnv) => {
    expect(() =>
      resolvePayPalConfig({ enabled: 'true', environment: 'live', ...CREDS }, elintysEnv, nodeEnv),
    ).toThrow('PAYPAL_ENV=live is disabled');
  });

  it('devrait refuser live même lorsque le fournisseur est désactivé', () => {
    expect(() =>
      resolvePayPalConfig({ enabled: 'false', environment: 'live', ...CREDS }, 'dev', 'development'),
    ).toThrow('PAYPAL_ENV=live is disabled');
  });

  it('devrait refuser live même sur un hôte de production explicite', () => {
    expect(() =>
      resolvePayPalConfig(
        { enabled: 'true', environment: 'live', ...CREDS },
        'prod',
        'production',
      ),
    ).toThrow('sandbox-only');
  });
});

describe('describePayPalConfig', () => {
  it('ne devrait jamais exposer de secret', () => {
    const config = resolvePayPalConfig(
      { enabled: 'true', environment: 'sandbox', ...CREDS },
      'dev',
      'development',
    );
    const described = JSON.stringify(describePayPalConfig(config));
    expect(described).not.toContain(CREDS.clientSecret);
    expect(described).not.toContain(CREDS.clientId);
    expect(described).not.toContain(CREDS.webhookId);
    expect(described).toContain('"clientSecretPresent":true');
  });
});
