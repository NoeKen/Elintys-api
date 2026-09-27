import {
  GuardInput,
  PRODUCTION_ACK_VALUE,
  ScriptGuardError,
  assertConnectedDatabase,
  assertUatTarget,
  describeMongoUri,
  formatSafeError,
  resolveGuardedTarget,
} from './environment-guard';

function input(overrides: Partial<GuardInput>): GuardInput {
  return {
    cliEnvironment: 'dev',
    elintysEnv: 'dev',
    databaseName: 'elintys-dev',
    writes: false,
    backupPath: undefined,
    confirmDatabase: undefined,
    productionAck: undefined,
    ...overrides,
  };
}

const PROD_OK: Partial<GuardInput> = {
  cliEnvironment: 'prod',
  elintysEnv: 'prod',
  databaseName: 'elintys',
  confirmDatabase: 'elintys',
  productionAck: PRODUCTION_ACK_VALUE,
  backupPath: '/secure/backups',
  writes: true,
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ScriptGuardError ? error.code : 'NOT_A_GUARD_ERROR';
  }
  return undefined;
}

describe('resolveGuardedTarget', () => {
  it.each([
    ['dev', 'elintys-dev'],
    ['uat', 'elintys-uat'],
  ])('devrait accepter %s avec la base %s', (environment, databaseName) => {
    expect(resolveGuardedTarget(input({ cliEnvironment: environment, elintysEnv: environment, databaseName })))
      .toEqual({ environment, databaseName, productionConfirmed: false });
  });

  it('devrait exiger --environment', () => {
    expect(codeOf(() => resolveGuardedTarget(input({ cliEnvironment: undefined })))).toBe('ENVIRONMENT_FLAG_REQUIRED');
  });

  it.each(['ci', 'production', 'staging', 'DEV', ''])('devrait refuser --environment=%s', (value) => {
    const code = codeOf(() => resolveGuardedTarget(input({ cliEnvironment: value, elintysEnv: value })));
    expect(['ENVIRONMENT_FLAG_INVALID', 'ENVIRONMENT_FLAG_REQUIRED']).toContain(code);
  });

  it.each([
    ['uat', 'dev'],
    ['dev', 'uat'],
    ['dev', undefined],
    ['uat', 'prod'],
  ])('devrait refuser --environment=%s quand ELINTYS_ENV=%s', (cliEnvironment, elintysEnv) => {
    expect(codeOf(() => resolveGuardedTarget(input({ cliEnvironment, elintysEnv })))).toBe('ENVIRONMENT_MISMATCH');
  });

  it.each([
    ['dev', 'elintys-uat'],
    ['uat', 'elintys-dev'],
    ['uat', 'elintys'],
    ['dev', 'elintys-test'],
    ['uat', 'elintys-uat-copy'],
  ])('devrait refuser %s sur la base %s', (environment, databaseName) => {
    expect(codeOf(() => resolveGuardedTarget(input({ cliEnvironment: environment, elintysEnv: environment, databaseName }))))
      .toBe('DATABASE_MISMATCH');
  });

  it('devrait refuser une URI sans nom de base', () => {
    expect(codeOf(() => resolveGuardedTarget(input({ databaseName: undefined })))).toBe('DATABASE_NAME_MISSING');
  });

  it('devrait exiger un backup pour toute écriture', () => {
    expect(codeOf(() => resolveGuardedTarget(input({ writes: true })))).toBe('BACKUP_PATH_REQUIRED');
    expect(resolveGuardedTarget(input({ writes: true, backupPath: '/tmp/b' })).environment).toBe('dev');
  });

  it('devrait refuser une confirmation de base divergente hors production', () => {
    expect(codeOf(() => resolveGuardedTarget(input({ confirmDatabase: 'elintys-uat' })))).toBe('CONFIRM_DATABASE_MISMATCH');
  });

  describe('production', () => {
    it('devrait accepter uniquement avec TOUTES les confirmations', () => {
      expect(resolveGuardedTarget(input(PROD_OK))).toEqual({
        environment: 'prod',
        databaseName: 'elintys',
        productionConfirmed: true,
      });
    });

    it.each<[string, Partial<GuardInput>, string]>([
      ['sans --environment=prod', { cliEnvironment: 'dev' }, 'ENVIRONMENT_MISMATCH'],
      ['sans ELINTYS_ENV=prod', { elintysEnv: 'uat' }, 'ENVIRONMENT_MISMATCH'],
      ['sans ELINTYS_ALLOW_PRODUCTION_MIGRATION', { productionAck: undefined }, 'PRODUCTION_ACK_REQUIRED'],
      ['avec un accusé approximatif', { productionAck: 'yes' }, 'PRODUCTION_ACK_REQUIRED'],
      ['sans --confirm-database', { confirmDatabase: undefined }, 'PRODUCTION_CONFIRM_DATABASE_REQUIRED'],
      ['avec --confirm-database divergent', { confirmDatabase: 'elintys-prod' }, 'CONFIRM_DATABASE_MISMATCH'],
      ['sans backup', { backupPath: undefined }, 'PRODUCTION_BACKUP_PATH_REQUIRED'],
      ['sans backup même en dry-run', { backupPath: undefined, writes: false }, 'PRODUCTION_BACKUP_PATH_REQUIRED'],
      ['sur une base dev', { databaseName: 'elintys-dev', confirmDatabase: 'elintys-dev' }, 'PRODUCTION_DATABASE_NAME_FORBIDDEN'],
      ['sur une base uat', { databaseName: 'elintys-uat', confirmDatabase: 'elintys-uat' }, 'PRODUCTION_DATABASE_NAME_FORBIDDEN'],
      ['sur une base test', { databaseName: 'elintys-TEST', confirmDatabase: 'elintys-TEST' }, 'PRODUCTION_DATABASE_NAME_FORBIDDEN'],
    ])('devrait refuser %s', (_label, overrides, expected) => {
      expect(codeOf(() => resolveGuardedTarget(input({ ...PROD_OK, ...overrides })))).toBe(expected);
    });
  });
});

describe('assertConnectedDatabase', () => {
  it('devrait refuser une base connectée différente de la cible', () => {
    const target = resolveGuardedTarget(input({}));
    expect(() => assertConnectedDatabase(target, 'elintys-dev')).not.toThrow();
    expect(codeOf(() => assertConnectedDatabase(target, 'elintys'))).toBe('CONNECTED_DATABASE_MISMATCH');
    expect(codeOf(() => assertConnectedDatabase(target, undefined))).toBe('CONNECTED_DATABASE_MISMATCH');
  });
});

describe('assertUatTarget', () => {
  it('devrait accepter uniquement uat + elintys-uat', () => {
    expect(assertUatTarget('uat', 'elintys-uat')).toEqual({ environment: 'uat', databaseName: 'elintys-uat', productionConfirmed: false });
  });

  it.each<[string | undefined, string | undefined, string]>([
    ['dev', 'elintys-uat', 'UAT_ENVIRONMENT_REQUIRED'],
    ['prod', 'elintys-uat', 'UAT_ENVIRONMENT_REQUIRED'],
    [undefined, 'elintys-uat', 'UAT_ENVIRONMENT_REQUIRED'],
    ['uat', 'elintys-dev', 'UAT_DATABASE_REQUIRED'],
    ['uat', 'elintys', 'UAT_DATABASE_REQUIRED'],
    ['uat', undefined, 'UAT_DATABASE_REQUIRED'],
    ['uat', 'elintys-uat-prod', 'PRODUCTION_DATABASE_REFUSED'],
    ['uat', 'PROD', 'PRODUCTION_DATABASE_REFUSED'],
  ])('devrait refuser ELINTYS_ENV=%s base=%s', (env, databaseName, expected) => {
    expect(codeOf(() => assertUatTarget(env, databaseName))).toBe(expected);
  });
});

describe('describeMongoUri', () => {
  it('devrait extraire l’hôte sans identifiants et le nom de base', () => {
    expect(describeMongoUri('mongodb+srv://user:s3cr%40t@cluster0.example.mongodb.net/elintys-uat?retryWrites=true'))
      .toEqual({ clusterHost: 'cluster0.example.mongodb.net', databaseName: 'elintys-uat' });
    expect(describeMongoUri('mongodb://a:b@h1:27017,h2:27017/elintys-dev?replicaSet=rs0'))
      .toEqual({ clusterHost: 'h1:27017,h2:27017', databaseName: 'elintys-dev' });
    expect(describeMongoUri('mongodb://localhost:27017')).toEqual({ clusterHost: 'localhost:27017', databaseName: undefined });
  });

  it('ne devrait jamais exposer le mot de passe', () => {
    const description = describeMongoUri('mongodb+srv://admin:SuperSecret@cluster.example.net/elintys-uat');
    expect(JSON.stringify(description)).not.toContain('SuperSecret');
    expect(JSON.stringify(description)).not.toContain('admin');
  });

  it('devrait refuser un schéma inconnu', () => {
    expect(codeOf(() => describeMongoUri('postgres://x/y'))).toBe('MONGODB_URI_INVALID');
  });
});

describe('formatSafeError', () => {
  it('devrait n’imprimer que le code des erreurs non maîtrisées', () => {
    expect(formatSafeError(new ScriptGuardError('BACKUP_PATH_REQUIRED', 'détail'))).toBe('BACKUP_PATH_REQUIRED: détail');
    expect(formatSafeError(new Error('VENUE_OWNER_MISSING'))).toBe('VENUE_OWNER_MISSING');
    expect(formatSafeError(new Error('APPLY_REFUSED: index x'))).toBe('APPLY_REFUSED');
    expect(formatSafeError(new Error('connect ECONNREFUSED user:pw@host'))).toBe('DATABASE_OR_UNEXPECTED_ERROR');
    expect(formatSafeError('boom')).toBe('DATABASE_OR_UNEXPECTED_ERROR');
  });
});
