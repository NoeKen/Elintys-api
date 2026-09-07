import {
  describePayPalConfig,
  isPayPalEnvironment,
  PAYPAL_ENVIRONMENTS,
  resolvePayPalConfig,
  type PayPalEnvironment,
} from './paypal-environment';

const CREDS = {
  clientId: 'fake-client-id',
  clientSecret: 'fake-secret',
  webhookId: 'WH-FAKE-123',
};

/** Aucun credential réel n'est utilisé : ces tests n'appellent jamais PayPal. */
const resolve = (
  environment: string | undefined,
  enabled = 'true',
  creds: Partial<typeof CREDS> = {},
) => resolvePayPalConfig({ enabled, environment, ...CREDS, ...creds }, 'dev', 'development');

afterEach(() => jest.clearAllMocks());

describe('resolvePayPalConfig — fournisseur désactivé', () => {
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

  it('devrait valider PAYPAL_ENV même lorsque le fournisseur est désactivé', () => {
    // Une valeur invalide est une erreur d'exploitation : la masquer parce que
    // le fournisseur est éteint ferait échouer l'activation plus tard, ailleurs.
    expect(() => resolve('staging', 'false')).toThrow('PAYPAL_ENV');
  });
});

describe('resolvePayPalConfig — dérivation par environnement', () => {
  it('devrait dériver les endpoints Sandbox', () => {
    const config = resolve('sandbox');

    expect(config).toMatchObject({
      enabled: true,
      environment: 'sandbox',
      baseUrl: 'https://api-m.sandbox.paypal.com',
    });
    expect(config.approvalHosts).toContain('sandbox.paypal.com');
  });

  it('devrait dériver les endpoints Live', () => {
    const config = resolve('live');

    expect(config).toMatchObject({
      enabled: true,
      environment: 'live',
      baseUrl: 'https://api-m.paypal.com',
    });
    expect(config.approvalHosts).toContain('www.paypal.com');
  });

  it('devrait utiliser sandbox par défaut lorsque PAYPAL_ENV est absent', () => {
    // Le défaut penche vers l'environnement inoffensif : une variable oubliée
    // ne doit jamais aboutir à des paiements réels.
    expect(resolve(undefined).environment).toBe('sandbox');
  });

  it.each(['SANDBOX', ' live ', 'Live'])('devrait normaliser %p', (raw) => {
    expect(() => resolve(raw)).not.toThrow();
  });

  it.each(['staging', 'production', 'prod', 'test', 'sandbox2'])(
    'devrait refuser la valeur PAYPAL_ENV %p',
    (raw) => {
      expect(() => resolve(raw)).toThrow('PAYPAL_ENV');
    },
  );

  it('devrait exposer exactement deux environnements supportés', () => {
    expect([...PAYPAL_ENVIRONMENTS]).toEqual(['sandbox', 'live']);
    expect(isPayPalEnvironment('sandbox')).toBe(true);
    expect(isPayPalEnvironment('live')).toBe(true);
    expect(isPayPalEnvironment('staging')).toBe(false);
  });
});

describe('resolvePayPalConfig — fail-closed', () => {
  it.each([
    ['PAYPAL_CLIENT_ID', { clientId: '  ' }],
    ['PAYPAL_CLIENT_SECRET', { clientSecret: undefined }],
    ['PAYPAL_WEBHOOK_ID', { webhookId: '' }],
  ])('devrait refuser de démarrer sans %s en sandbox', (name, creds) => {
    expect(() => resolve('sandbox', 'true', creds)).toThrow(name);
  });

  it.each([
    ['PAYPAL_CLIENT_ID', { clientId: undefined }],
    ['PAYPAL_CLIENT_SECRET', { clientSecret: '   ' }],
    ['PAYPAL_WEBHOOK_ID', { webhookId: undefined }],
  ])('devrait refuser de démarrer sans %s en live', (name, creds) => {
    // Live n'est pas plus permissif que Sandbox : credentials incomplètes
    // ⇒ refus de démarrage, jamais un repli sur Sandbox.
    expect(() => resolve('live', 'true', creds)).toThrow(name);
  });

  it('ne devrait JAMAIS replier live sur sandbox', () => {
    const config = resolve('live');
    expect(config.baseUrl).not.toContain('sandbox');
    expect(config.approvalHosts.join(',')).not.toContain('sandbox');
  });

  it('ne devrait JAMAIS replier sandbox sur live', () => {
    const config = resolve('sandbox');
    expect(config.baseUrl).toContain('sandbox');
    expect(config.approvalHosts.every((host) => host.includes('sandbox'))).toBe(true);
  });
});

describe('resolvePayPalConfig — indépendance vis-à-vis de NODE_ENV', () => {
  it.each([
    ['dev', 'development'],
    ['dev', 'production'],
    ['prod', 'development'],
    ['prod', 'production'],
  ])(
    'devrait donner le MÊME résultat sandbox avec ELINTYS_ENV=%s et NODE_ENV=%s',
    (elintysEnv, nodeEnv) => {
      const config = resolvePayPalConfig(
        { enabled: 'true', environment: 'sandbox', ...CREDS },
        elintysEnv,
        nodeEnv,
      );
      expect(config.environment).toBe('sandbox');
      expect(config.baseUrl).toBe('https://api-m.sandbox.paypal.com');
    },
  );

  it('un build NODE_ENV=production ne bascule pas PayPal en live', () => {
    // Les deux dimensions sont indépendantes : c'est PAYPAL_ENV, et lui seul,
    // qui décide de l'environnement de paiement.
    const config = resolvePayPalConfig(
      { enabled: 'true', environment: 'sandbox', ...CREDS },
      'prod',
      'production',
    );
    expect(config.environment).toBe('sandbox');
  });

  it('un NODE_ENV=development ne bloque pas une configuration live explicite', () => {
    const config = resolvePayPalConfig(
      { enabled: 'true', environment: 'live', ...CREDS },
      'dev',
      'development',
    );
    expect(config.environment).toBe('live');
  });
});

describe('bascule sandbox ↔ live sans modification de code', () => {
  it('devrait produire deux configurations distinctes depuis le MÊME code', () => {
    // Preuve d'architecture : seule la variable change entre les deux appels.
    const raw = { enabled: 'true', ...CREDS };

    const sandbox = resolvePayPalConfig({ ...raw, environment: 'sandbox' }, 'prod', 'production');
    const live = resolvePayPalConfig({ ...raw, environment: 'live' }, 'prod', 'production');

    expect(sandbox.baseUrl).not.toBe(live.baseUrl);
    expect(sandbox.approvalHosts).not.toEqual(live.approvalHosts);
    // Tout le reste est identique : rien d'autre ne dépend de l'environnement.
    expect(sandbox.clientId).toBe(live.clientId);
    expect(sandbox.webhookId).toBe(live.webhookId);
    expect(sandbox.enabled).toBe(live.enabled);
  });

  it('devrait rester réversible live → sandbox', () => {
    const raw = { enabled: 'true', ...CREDS };
    const first = resolvePayPalConfig({ ...raw, environment: 'live' }, 'prod', 'production');
    const back = resolvePayPalConfig({ ...raw, environment: 'sandbox' }, 'prod', 'production');

    expect(first.environment).toBe('live');
    expect(back.environment).toBe('sandbox');
    expect(back.baseUrl).toBe('https://api-m.sandbox.paypal.com');
  });

  it('chaque environnement a son propre webhook, jamais partagé', () => {
    // Le webhook ID est fourni par variable : Sandbox et Live restent séparés
    // parce qu'ils sont déployés avec des variables distinctes.
    const sandbox = resolvePayPalConfig(
      { enabled: 'true', environment: 'sandbox', ...CREDS, webhookId: 'WH-SANDBOX' },
      'dev',
      'development',
    );
    const live = resolvePayPalConfig(
      { enabled: 'true', environment: 'live', ...CREDS, webhookId: 'WH-LIVE' },
      'prod',
      'production',
    );

    expect(sandbox.webhookId).toBe('WH-SANDBOX');
    expect(live.webhookId).toBe('WH-LIVE');
  });
});

describe('describePayPalConfig', () => {
  it('ne devrait jamais exposer de secret', () => {
    const described = JSON.stringify(describePayPalConfig(resolve('sandbox')));

    expect(described).not.toContain(CREDS.clientSecret);
    expect(described).not.toContain(CREDS.clientId);
    expect(described).not.toContain(CREDS.webhookId);
    expect(described).toContain('"clientSecretPresent":true');
  });

  it('devrait exposer l’environnement effectif pour le diagnostic', () => {
    const described = describePayPalConfig(resolve('live')) as {
      environment: PayPalEnvironment;
    };
    expect(described.environment).toBe('live');
  });
});
