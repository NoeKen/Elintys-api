import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResettableDb, clearCollections, planReset } from './reset-uat';

describe('reset UAT — refus', () => {
  let dir: string;
  let envFile: string;
  // Le fichier choisi est la source de vérité : chaque cas écrit son propre fichier.
  const writeEnv = (overrides: Record<string, string> = {}) => {
    const values = {
      ELINTYS_ENV: 'uat',
      MONGODB_URI: 'mongodb+srv://u:p@cluster0.example.mongodb.net/elintys-uat',
      UAT_SEED_PASSWORD: 'Recette-UAT-2026!',
      ...overrides,
    };
    writeFileSync(envFile, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'));
    return `--env-file=${envFile}`;
  };
  const uatEnv = (): Record<string, string> => ({});
  const okFlags = ['--confirm=elintys-uat', '--backup-path=/secure/backups'];
  let ok: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'elintys-reset-'));
    envFile = join(dir, '.env.uat.local');
    ok = [...okFlags, writeEnv()];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('devrait exiger un fichier d’environnement explicite', () => {
    expect(() => planReset(okFlags, { ELINTYS_ENV: 'uat', MONGODB_URI: 'mongodb://h/elintys-uat' })).toThrow('ENV_FILE_REQUIRED');
  });

  it('devrait accepter uniquement uat + elintys-uat + confirmation + backup', () => {
    expect(planReset(ok, uatEnv())).toMatchObject({
      clusterHost: 'cluster0.example.mongodb.net',
      target: { environment: 'uat', databaseName: 'elintys-uat' },
      backupPath: '/secure/backups',
      reseed: false,
    });
    expect(planReset(['--confirm=elintys-uat', '--skip-backup', writeEnv()], uatEnv()).backupPath).toBeUndefined();
  });

  it.each<[string, string[], Record<string, string>, string]>([
    ['ELINTYS_ENV=prod', okFlags, { ELINTYS_ENV: 'prod' }, 'UAT_ENVIRONMENT_REQUIRED'],
    ['ELINTYS_ENV=dev', okFlags, { ELINTYS_ENV: 'dev' }, 'UAT_ENVIRONMENT_REQUIRED'],
    ['base dev', okFlags, { MONGODB_URI: 'mongodb://h/elintys-dev' }, 'UAT_DATABASE_REQUIRED'],
    ['base de production', okFlags, { MONGODB_URI: 'mongodb://h/elintys' }, 'UAT_DATABASE_REQUIRED'],
    ['base contenant prod', okFlags, { MONGODB_URI: 'mongodb://h/elintys-uat-prod' }, 'PRODUCTION_DATABASE_REFUSED'],
    ['sans --confirm', ['--backup-path=/b'], {}, 'RESET_CONFIRMATION_REQUIRED'],
    ['confirmation erronée', ['--confirm=elintys-dev', '--backup-path=/b'], {}, 'RESET_CONFIRMATION_REQUIRED'],
    ['confirmation vide', ['--confirm', '--backup-path=/b'], {}, 'FLAG_VALUE_REQUIRED'],
    ['sans backup ni --skip-backup', ['--confirm=elintys-uat'], {}, 'BACKUP_PATH_REQUIRED'],
    ['--skip-backup avec --backup-path', [...okFlags, '--skip-backup'], {}, 'CONFLICTING_FLAGS'],
    ['--reseed sans mot de passe', [...okFlags, '--reseed'], { UAT_SEED_PASSWORD: '' }, 'UAT_SEED_PASSWORD_REQUIRED'],
    ['drapeau inconnu', [...okFlags, '--drop-database'], {}, 'UNKNOWN_FLAG'],
  ])('devrait refuser %s avant toute connexion', (_label, argv, overrides, code) => {
    expect(() => planReset([...argv, writeEnv(overrides)], uatEnv())).toThrow(code);
  });

  it('devrait refuser un fichier d’environnement de production', () => {
    const file = join(dir, '.env.prod.local');
    writeFileSync(file, 'ELINTYS_ENV=uat\n');
    expect(() => planReset([...okFlags, `--env-file=${file}`], uatEnv())).toThrow('ENV_FILE_PRODUCTION_REFUSED');
  });
});

describe('reset UAT — suppression', () => {
  function fakeDb(databaseName: string) {
    const deleteMany = jest.fn(async () => ({ deletedCount: 2 }));
    const db = {
      databaseName,
      listCollections: () => ({ toArray: async () => [{ name: 'users' }, { name: 'system.views' }, { name: 'v', type: 'view' }, { name: 'events' }] }),
      collection: jest.fn(() => ({ deleteMany, find: jest.fn(), indexes: jest.fn() })),
    };
    return { db: db as unknown as ResettableDb, deleteMany, collection: db.collection };
  }

  it('devrait vider les collections applicatives sans toucher aux index ni aux vues système', async () => {
    const { db, deleteMany, collection } = fakeDb('elintys-uat');
    await expect(clearCollections(db)).resolves.toEqual({ events: 2, users: 2 });
    expect(collection.mock.calls.map((call: unknown[]) => call[0])).toEqual(['events', 'users']);
    expect(deleteMany).toHaveBeenCalledWith({});
  });

  it('devrait refuser une base connectée autre que elintys-uat', async () => {
    const { db, deleteMany } = fakeDb('elintys');
    await expect(clearCollections(db)).rejects.toThrow('CONNECTED_DATABASE_MISMATCH');
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
