import {
  evaluateEnvironment,
  parseMongoUri,
  validateEnvironment,
} from './env.validation';

const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);
const DB_PASSWORD = 'SuperSecretDbPassword42';
const atlas = (db: string) =>
  `mongodb+srv://elintys:${DB_PASSWORD}@cluster0.abcde.mongodb.net/${db}?retryWrites=true&w=majority`;

const UAT: Record<string, string> = {
  NODE_ENV: 'production',
  ELINTYS_ENV: 'uat',
  MONGODB_URI: atlas('elintys-uat'),
  JWT_SECRET: SECRET_A,
  JWT_REFRESH_SECRET: SECRET_B,
  CORS_ORIGINS: 'https://uat.elintys.com',
  FRONTEND_URL: 'https://uat.elintys.com',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_PROVIDER_ENABLED: 'false',
  PAID_CHECKOUT_ENABLED: 'false',
  EMAIL_DELIVERY_ENABLED: 'true',
  RESEND_API_KEY: 're_test_key_value',
  EMAIL_FROM: 'Elintys UAT <no-reply@elintys.com>',
  CLOUDINARY_FOLDER: 'uat',
  CLOUDINARY_CLOUD_NAME: 'cloud',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'cloudinary-secret',
  TRUSTED_PROXY_HOPS: '1',
};

const PROD: Record<string, string> = {
  ...UAT,
  ELINTYS_ENV: 'prod',
  MONGODB_URI: atlas('elintys'),
  CORS_ORIGINS: 'https://app.elintys.com,https://elintys.com',
  FRONTEND_URL: 'https://app.elintys.com',
  PAYPAL_ENV: 'live',
  CLOUDINARY_FOLDER: 'prod',
  EMAIL_FROM: 'Elintys <no-reply@elintys.com>',
};

const DEV: Record<string, string> = {
  NODE_ENV: 'production',
  ELINTYS_ENV: 'dev',
  MONGODB_URI: atlas('elintys-dev'),
  JWT_SECRET: SECRET_A,
  JWT_REFRESH_SECRET: SECRET_B,
  CORS_ORIGINS: 'https://dev.elintys.com',
  FRONTEND_URL: 'https://dev.elintys.com',
  RESEND_API_KEY: 're_dev',
  EMAIL_FROM: 'Elintys DEV <no-reply@elintys.com>',
};

const LOCAL: Record<string, string> = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://localhost:27017/elintys',
};

const CI: Record<string, string> = {
  NODE_ENV: 'test',
  ELINTYS_ENV: 'ci',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/elintys-test',
};

const errorsOf = (env: Record<string, string | undefined>) =>
  evaluateEnvironment(env).errors.map((e) => `${e.variable} ${e.reason}`);
const warningsOf = (env: Record<string, string | undefined>) =>
  evaluateEnvironment(env).warnings.map((e) => `${e.variable} ${e.reason}`);
const without = (env: Record<string, string>, name: string) => {
  const copy: Record<string, string | undefined> = { ...env };
  delete copy[name];
  return copy;
};

describe('evaluateEnvironment — configurations de référence', () => {
  it.each([
    ['uat', UAT],
    ['prod', PROD],
    ['dev', DEV],
    ['local', LOCAL],
    ['ci', CI],
  ])('devrait accepter une configuration %s complète sans erreur', (_name, env) => {
    expect(errorsOf(env)).toEqual([]);
  });

  it('devrait accepter uat et prod sans aucun avertissement', () => {
    expect(warningsOf(UAT)).toEqual([]);
    expect(warningsOf(PROD)).toEqual([]);
  });

  it('devrait résoudre local quand ELINTYS_ENV est absent hors production', () => {
    expect(evaluateEnvironment(LOCAL).elintysEnv).toBe('local');
  });
});

describe('evaluateEnvironment — ELINTYS_ENV', () => {
  it('devrait exiger ELINTYS_ENV sous NODE_ENV=production', () => {
    expect(errorsOf(without(UAT, 'ELINTYS_ENV'))).toEqual([
      'ELINTYS_ENV is required when NODE_ENV=production (one of: local, ci, dev, uat, prod).',
    ]);
  });

  it('devrait refuser une valeur inconnue', () => {
    expect(errorsOf({ ...UAT, ELINTYS_ENV: 'staging' })).toEqual([
      'ELINTYS_ENV must be one of: local, ci, dev, uat, prod.',
    ]);
  });

  it.each(['uat', 'prod'])('devrait exiger NODE_ENV=production pour %s', (elintysEnv) => {
    const base = elintysEnv === 'uat' ? UAT : PROD;
    expect(errorsOf({ ...base, NODE_ENV: 'development' })).toContain(
      `NODE_ENV must be "production" when ELINTYS_ENV=${elintysEnv}`,
    );
  });
});

describe('evaluateEnvironment — uat / prod : variables requises', () => {
  it.each([
    'MONGODB_URI',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'CORS_ORIGINS',
    'FRONTEND_URL',
    'RESEND_API_KEY',
    'EMAIL_FROM',
  ])('devrait refuser de démarrer en uat sans %s', (name) => {
    expect(errorsOf(without(UAT, name))).toContain(`${name} is required`);
    expect(errorsOf(without(PROD, name))).toContain(`${name} is required`);
  });

  it.each(['MONGODB_URI', 'JWT_SECRET', 'CORS_ORIGINS', 'FRONTEND_URL', 'EMAIL_FROM'])(
    'devrait refuser explicitement un placeholder __SET_ME__ pour %s',
    (name) => {
      expect(errorsOf({ ...UAT, [name]: '__SET_ME__' })).toContain(
        `${name} is not configured (placeholder __SET_ME__ value)`,
      );
      expect(errorsOf({ ...UAT, [name]: '__SET_ME__uat_value' })).toContain(
        `${name} is not configured (placeholder __SET_ME__ value)`,
      );
    },
  );

  it('devrait traiter une valeur vide comme absente', () => {
    expect(errorsOf({ ...UAT, JWT_SECRET: '   ' })).toContain('JWT_SECRET is required');
  });
});

describe('evaluateEnvironment — MONGODB_URI', () => {
  it('devrait exiger exactement elintys-uat en uat', () => {
    for (const db of ['elintys-dev', 'elintys', 'elintys-uat-copy', '']) {
      expect(errorsOf({ ...UAT, MONGODB_URI: atlas(db) })).toContain(
        'MONGODB_URI database name must be exactly "elintys-uat" when ELINTYS_ENV=uat',
      );
    }
  });

  it.each(['elintys-dev', 'elintys-uat', 'elintys_test', 'Local-copy', 'devdb'])(
    'devrait refuser la base %s en prod',
    (db) => {
      expect(errorsOf({ ...PROD, MONGODB_URI: atlas(db) })).toContain(
        'MONGODB_URI database name must not contain dev, uat, test or local when ELINTYS_ENV=prod',
      );
    },
  );

  it('devrait refuser une URI prod sans nom de base (base "test" implicite)', () => {
    expect(errorsOf({ ...PROD, MONGODB_URI: 'mongodb+srv://u:p@c.mongodb.net/?w=majority' })).toContain(
      'MONGODB_URI must name the production database explicitly (no implicit "test" database)',
    );
  });

  it('devrait refuser une URI illisible', () => {
    expect(errorsOf({ ...UAT, MONGODB_URI: 'postgres://x/y' })).toContain(
      'MONGODB_URI is not a valid mongodb:// or mongodb+srv:// URI',
    );
  });

  it('devrait exiger elintys-dev quand ELINTYS_ENV=dev', () => {
    expect(errorsOf({ ...DEV, MONGODB_URI: atlas('elintys-uat') })).toContain(
      'MONGODB_URI database name must be exactly "elintys-dev" when ELINTYS_ENV=dev',
    );
  });

  it.each([
    ['local', LOCAL],
    ['ci', CI],
    ['dev', DEV],
  ])('devrait exiger MONGODB_URI même en %s (aucun repli implicite)', (_name, env) => {
    expect(errorsOf(without(env, 'MONGODB_URI'))).toContain('MONGODB_URI is required');
  });

  it('devrait refuser Atlas / un cluster distant en CI', () => {
    expect(errorsOf({ ...CI, MONGODB_URI: atlas('elintys-test') })).toContain(
      'MONGODB_URI must target a local/ephemeral MongoDB in CI (never Atlas or a remote cluster)',
    );
    expect(errorsOf({ ...CI, MONGODB_URI: 'mongodb://db.example.com:27017/elintys-test' })).toHaveLength(1);
  });

  it('devrait accepter le conteneur de service CI et avertir sur un nom inattendu', () => {
    expect(errorsOf({ ...CI, MONGODB_URI: 'mongodb://mongo:27017/other' })).toEqual([]);
    expect(warningsOf({ ...CI, MONGODB_URI: 'mongodb://mongo:27017/other' })).toContain(
      'MONGODB_URI database name should be "elintys-test" in CI',
    );
  });

  it('devrait refuser en local une base distante autre que elintys-dev', () => {
    expect(errorsOf({ ...LOCAL, MONGODB_URI: atlas('elintys-uat') })).toContain(
      'MONGODB_URI a remote database is only allowed locally when it is "elintys-dev"',
    );
    expect(errorsOf({ ...LOCAL, MONGODB_URI: atlas('elintys') })).toHaveLength(1);
  });

  it('devrait avertir (sans bloquer) un poste local branché sur elintys-dev', () => {
    const env = { ...LOCAL, MONGODB_URI: atlas('elintys-dev') };
    expect(errorsOf(env)).toEqual([]);
    expect(warningsOf(env)).toContain(
      'MONGODB_URI local instance is connected to the remote "elintys-dev" database',
    );
  });
});

describe('evaluateEnvironment — JWT', () => {
  it('devrait exiger au moins 32 caractères en uat/prod', () => {
    expect(errorsOf({ ...UAT, JWT_SECRET: 'short' })).toContain(
      'JWT_SECRET must be at least 32 characters long',
    );
    expect(errorsOf({ ...PROD, JWT_REFRESH_SECRET: 'x'.repeat(31) })).toContain(
      'JWT_REFRESH_SECRET must be at least 32 characters long',
    );
  });

  it('devrait exiger deux secrets distincts en uat/prod', () => {
    expect(errorsOf({ ...UAT, JWT_REFRESH_SECRET: SECRET_A })).toContain(
      'JWT_REFRESH_SECRET must differ from JWT_SECRET',
    );
  });

  it('devrait exiger la présence en dev mais seulement avertir sur la robustesse', () => {
    expect(errorsOf(without(DEV, 'JWT_REFRESH_SECRET'))).toContain('JWT_REFRESH_SECRET is required');
    const weak = { ...DEV, JWT_SECRET: 'short', JWT_REFRESH_SECRET: 'short' };
    expect(errorsOf(weak)).toEqual([]);
    expect(warningsOf(weak)).toEqual(
      expect.arrayContaining([
        'JWT_SECRET must be at least 32 characters long',
        'JWT_REFRESH_SECRET must differ from JWT_SECRET',
      ]),
    );
  });

  it('devrait rester permissif en local', () => {
    expect(errorsOf({ ...LOCAL, JWT_SECRET: 'x', JWT_REFRESH_SECRET: '__SET_ME__' })).toEqual([]);
    expect(warningsOf({ ...LOCAL, JWT_REFRESH_SECRET: '__SET_ME__' })).toContain(
      'JWT_REFRESH_SECRET is not configured (placeholder __SET_ME__ value)',
    );
  });
});

describe('evaluateEnvironment — CORS_ORIGINS / FRONTEND_URL', () => {
  it.each([
    ['http://uat.elintys.com', 'entry #1 must use https'],
    ['https://localhost:3000', 'entry #1 must not target localhost or a private network'],
    ['https://192.168.1.10', 'entry #1 must not target localhost or a private network'],
    ['https://uat.elintys.com/', 'entry #1 must be a bare origin (https://host[:port]) without path or trailing slash'],
    ['https://uat.elintys.com,*', 'entry #2 must not contain a wildcard'],
    ['not a url', 'entry #1 must be a valid absolute URL'],
  ])('devrait refuser CORS_ORIGINS=%s en uat', (value, reason) => {
    expect(errorsOf({ ...UAT, CORS_ORIGINS: value })).toContain(`CORS_ORIGINS ${reason}`);
  });

  it('devrait refuser une liste CORS vide', () => {
    expect(errorsOf({ ...UAT, CORS_ORIGINS: ' , ' })).toContain('CORS_ORIGINS must list at least one origin');
  });

  it.each([
    ['http://uat.elintys.com', 'must use https'],
    ['https://127.0.0.1:3000', 'must not target localhost or a private network'],
  ])('devrait refuser FRONTEND_URL=%s en prod', (value, reason) => {
    expect(errorsOf({ ...PROD, FRONTEND_URL: value })).toContain(`FRONTEND_URL ${reason}`);
  });

  it('devrait seulement avertir en dev pour CORS/FRONTEND non conformes', () => {
    const env = { ...without(DEV, 'CORS_ORIGINS'), FRONTEND_URL: 'http://dev.elintys.com' };
    expect(errorsOf(env)).toEqual([]);
    expect(warningsOf(env)).toEqual(
      expect.arrayContaining(['CORS_ORIGINS is required', 'FRONTEND_URL must use https']),
    );
  });

  it('devrait exiger FRONTEND_URL dès que NODE_ENV=production (plus de repli localhost)', () => {
    expect(errorsOf(without(DEV, 'FRONTEND_URL'))).toContain('FRONTEND_URL is required');
    expect(errorsOf({ ...LOCAL, NODE_ENV: 'production', ELINTYS_ENV: 'local' })).toContain(
      'FRONTEND_URL is required',
    );
  });

  it('ne devrait pas exiger FRONTEND_URL en local hors production', () => {
    expect(errorsOf(LOCAL)).toEqual([]);
  });
});

describe('evaluateEnvironment — paiements', () => {
  it('devrait exiger PAYPAL_ENV=sandbox explicite en uat', () => {
    expect(errorsOf(without(UAT, 'PAYPAL_ENV'))).toContain(
      'PAYPAL_ENV must be explicitly set to "sandbox" when ELINTYS_ENV=uat',
    );
  });

  it.each([
    ['uat', UAT],
    ['dev', DEV],
    ['local', LOCAL],
    ['ci', CI],
  ])('devrait interdire PayPal live en %s', (_name, env) => {
    expect(errorsOf({ ...env, PAYPAL_ENV: 'LIVE' })).toContain(
      'PAYPAL_ENV live PayPal is only allowed when ELINTYS_ENV=prod',
    );
  });

  it('devrait exiger live en prod quand PayPal est activé', () => {
    expect(
      errorsOf({ ...PROD, PAYPAL_ENV: 'sandbox', PAYPAL_PROVIDER_ENABLED: 'true' }),
    ).toContain('PAYPAL_ENV must be "live" when PAYPAL_PROVIDER_ENABLED=true and ELINTYS_ENV=prod');
    expect(errorsOf({ ...PROD, PAYPAL_ENV: 'sandbox', PAYPAL_PROVIDER_ENABLED: 'false' })).toEqual([]);
  });

  it.each([
    ['uat', UAT],
    ['prod', PROD],
  ])('devrait interdire le fournisseur de paiement simulé en %s', (name, env) => {
    expect(errorsOf({ ...env, TEST_PAYMENT_PROVIDER_ENABLED: 'true' })).toContain(
      `TEST_PAYMENT_PROVIDER_ENABLED must not be enabled when ELINTYS_ENV=${name}`,
    );
  });

  it('devrait refuser une valeur PAYPAL_ENV inconnue', () => {
    expect(errorsOf({ ...UAT, PAYPAL_ENV: 'staging' }).join('\n')).toContain('PAYPAL_ENV must be one of');
  });
});

describe('evaluateEnvironment — courriel', () => {
  it('devrait considérer l’envoi actif par défaut (EMAIL_DELIVERY_ENABLED absent)', () => {
    expect(errorsOf(without(without(UAT, 'EMAIL_DELIVERY_ENABLED') as Record<string, string>, 'RESEND_API_KEY'))).toContain(
      'RESEND_API_KEY is required',
    );
  });

  it('ne devrait pas exiger Resend quand l’envoi est désactivé', () => {
    const env = { ...without(without(UAT, 'RESEND_API_KEY') as Record<string, string>, 'EMAIL_FROM'), EMAIL_DELIVERY_ENABLED: 'false' };
    expect(errorsOf(env)).toEqual([]);
  });

  it('devrait refuser un booléen invalide en uat et seulement avertir en dev', () => {
    expect(errorsOf({ ...UAT, EMAIL_DELIVERY_ENABLED: 'yes' }).join('\n')).toContain(
      'EMAIL_DELIVERY_ENABLED must be one of the following values',
    );
    expect(errorsOf({ ...DEV, EMAIL_DELIVERY_ENABLED: 'yes' })).toEqual([]);
    expect(warningsOf({ ...DEV, EMAIL_DELIVERY_ENABLED: 'yes' }).join('\n')).toContain('EMAIL_DELIVERY_ENABLED');
  });

  it('devrait seulement avertir en dev si Resend manque', () => {
    const env = without(DEV, 'RESEND_API_KEY');
    expect(errorsOf(env)).toEqual([]);
    expect(warningsOf(env)).toContain('RESEND_API_KEY is required');
  });
});

describe('evaluateEnvironment — Cloudinary', () => {
  it('devrait exiger CLOUDINARY_FOLDER=uat (ou absent) en uat', () => {
    expect(errorsOf({ ...UAT, CLOUDINARY_FOLDER: 'prod' })).toContain(
      'CLOUDINARY_FOLDER must be "uat" (or omitted) when ELINTYS_ENV=uat',
    );
    expect(errorsOf(without(UAT, 'CLOUDINARY_FOLDER'))).toEqual([]);
  });

  it('devrait interdire un dossier non-prod en prod', () => {
    expect(errorsOf({ ...PROD, CLOUDINARY_FOLDER: 'uat' })).toContain(
      'CLOUDINARY_FOLDER must not reference a non-production environment when ELINTYS_ENV=prod',
    );
  });

  it('devrait refuser un format de dossier invalide', () => {
    expect(errorsOf({ ...UAT, CLOUDINARY_FOLDER: '../x' }).join('\n')).toContain('CLOUDINARY_FOLDER must match');
  });

  it('devrait avertir si les identifiants Cloudinary manquent en uat', () => {
    expect(warningsOf(without(UAT, 'CLOUDINARY_API_SECRET'))).toContain('CLOUDINARY_API_SECRET is required');
  });

  it('devrait avertir en dev si le dossier diffère de dev', () => {
    expect(warningsOf({ ...DEV, CLOUDINARY_FOLDER: 'uat' })).toContain(
      'CLOUDINARY_FOLDER differs from "dev" while ELINTYS_ENV=dev',
    );
  });
});

describe('validateEnvironment', () => {
  it('devrait retourner la configuration inchangée', () => {
    const logger = { warn: jest.fn() };
    const config = { ...UAT, UNRELATED: 'kept' };
    expect(validateEnvironment(config, logger)).toBe(config);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('devrait lever un message clair listant toutes les variables fautives', () => {
    expect(() =>
      validateEnvironment({ ...without(UAT, 'JWT_SECRET'), CORS_ORIGINS: '__SET_ME__' }, { warn: jest.fn() }),
    ).toThrow(
      /Invalid environment configuration \(ELINTYS_ENV=uat\) — refusing to start:\n {2}- JWT_SECRET is required\n {2}- CORS_ORIGINS is not configured/,
    );
  });

  it('ne devrait JAMAIS inclure de valeur dans le message d’erreur ni les avertissements', () => {
    const logger = { warn: jest.fn() };
    const bad = {
      ...UAT,
      MONGODB_URI: atlas('elintys-dev'),
      JWT_SECRET: 'tooShortSecretValue',
      JWT_REFRESH_SECRET: 'tooShortSecretValue',
      RESEND_API_KEY: '__SET_ME__re_live_value',
      CORS_ORIGINS: 'http://evil.example.com',
    };
    let message = '';
    try {
      validateEnvironment(bad, logger);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const secret of [DB_PASSWORD, 'tooShortSecretValue', 're_live_value', 'evil.example.com', 'cluster0']) {
      expect(message).not.toContain(secret);
    }

    validateEnvironment({ ...DEV, JWT_SECRET: 'tooShortSecretValue' }, logger);
    const logged = logger.warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('[ELINTYS_ENV=dev] JWT_SECRET must be at least 32 characters long');
    expect(logged).not.toContain('tooShortSecretValue');
  });

  it('devrait signaler un environnement inconnu', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' }, { warn: jest.fn() })).toThrow(
      'ELINTYS_ENV=unknown',
    );
  });
});

describe('parseMongoUri', () => {
  it('devrait extraire hôtes et base sans dépendre des identifiants', () => {
    expect(parseMongoUri('mongodb://u:p%40ss@h1:27017,h2:27018/elintys-uat?replicaSet=rs0')).toEqual({
      srv: false,
      hosts: ['h1', 'h2'],
      databaseName: 'elintys-uat',
    });
    expect(parseMongoUri(atlas('elintys'))).toEqual({
      srv: true,
      hosts: ['cluster0.abcde.mongodb.net'],
      databaseName: 'elintys',
    });
    expect(parseMongoUri('mongodb://localhost')).toEqual({
      srv: false,
      hosts: ['localhost'],
      databaseName: '',
    });
  });

  it.each(['', 'mysql://x/y', 'mongodb://', 'mongodb://h/%E0%A4%A'])('devrait refuser %s', (uri) => {
    expect(parseMongoUri(uri)).toBeNull();
  });
});
