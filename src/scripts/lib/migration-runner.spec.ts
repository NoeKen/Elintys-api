import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import type { Db } from 'mongodb';
import { BackupDb, backupDatabase } from './database-backup';
import { MigrationDefinition, RunnerDependencies, resolveMode, runGuardedMigration } from './migration-runner';
import { flagEnabled, flagValue, loadExplicitEnvFile, parseCliFlags } from './script-cli';

const URI = 'mongodb+srv://ops-user:TopSecretPw@cluster0.example.mongodb.net/elintys-uat?retryWrites=true';

function makeDeps(events: string[], databaseName = 'elintys-uat'): RunnerDependencies & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    connect: jest.fn(async () => {
      events.push('connect');
      return { databaseName } as unknown as Db;
    }),
    disconnect: jest.fn(async () => {
      events.push('disconnect');
    }),
    backup: jest.fn(async () => {
      events.push('backup');
      return { directory: '/secure/elintys-uat-x', manifestPath: '/secure/elintys-uat-x/manifest.json', totalDocuments: 3, collections: [] };
    }),
    writeReport: jest.fn(async () => {
      events.push('report');
    }),
    log: (line: string) => {
      logs.push(line);
      if (line.includes('cible :')) events.push('banner');
    },
  };
}

function definition(events: string[], passed = true): MigrationDefinition {
  return {
    name: 'test-migration',
    run: jest.fn(async ({ mode }) => {
      events.push(`run:${mode}`);
      return {
        preflight: { ok: true },
        postValidation: mode === 'dry-run' ? undefined : { passed, checks: {}, errors: passed ? [] : ['COUNT_CHANGED'] },
      };
    }),
  };
}

describe('runGuardedMigration', () => {
  const env = { MONGODB_URI: URI, ELINTYS_ENV: 'uat' };

  it('devrait afficher la cible avant de se connecter, sans identifiants, et rester en dry-run par défaut', async () => {
    const events: string[] = [];
    const deps = makeDeps(events);
    const report = await runGuardedMigration(definition(events), ['--environment=uat'], { ...env }, deps);

    expect(events).toEqual(['banner', 'connect', 'run:dry-run', 'disconnect']);
    expect(report.status).toBe('dry-run');
    expect(deps.backup).not.toHaveBeenCalled();
    expect(deps.logs[0]).toContain('cluster=cluster0.example.mongodb.net');
    expect(deps.logs[0]).toContain('base=elintys-uat');
    expect(deps.logs.join('\n')).not.toMatch(/TopSecretPw|ops-user/);
  });

  it('devrait sauvegarder, migrer puis écrire le rapport à côté du backup en mode apply', async () => {
    const events: string[] = [];
    const deps = makeDeps(events);
    const report = await runGuardedMigration(
      definition(events),
      ['--environment=uat', '--apply', '--backup-path=/secure'],
      { ...env },
      deps,
    );

    expect(events).toEqual(['banner', 'connect', 'backup', 'run:apply', 'report', 'disconnect']);
    expect(report.status).toBe('succeeded');
    expect(deps.writeReport).toHaveBeenCalledWith('/secure/elintys-uat-x/migration-report.json', expect.any(String));
    const written = JSON.parse((deps.writeReport as jest.Mock).mock.calls[0][1] as string);
    expect(written).toMatchObject({ migration: 'test-migration', status: 'succeeded', database: 'elintys-uat' });
    expect(JSON.stringify(written)).not.toContain('TopSecretPw');
  });

  it('devrait échouer et consigner le rapport si la post-validation échoue', async () => {
    const events: string[] = [];
    const deps = makeDeps(events);
    await expect(
      runGuardedMigration(definition(events, false), ['--environment=uat', '--apply', '--backup-path=/secure'], { ...env }, deps),
    ).rejects.toThrow('POST_VALIDATION_FAILED');
    const written = JSON.parse((deps.writeReport as jest.Mock).mock.calls[0][1] as string);
    expect(written.status).toBe('failed');
    expect(written.error).toContain('POST_VALIDATION_FAILED');
    expect(events).toContain('disconnect');
  });

  it.each<[string, string[], Record<string, string>, string]>([
    ['sans --environment', [], env, 'ENVIRONMENT_FLAG_REQUIRED'],
    ['apply sans backup', ['--environment=uat', '--apply'], env, 'BACKUP_PATH_REQUIRED'],
    ['drapeau inconnu', ['--environment=uat', '--aply'], env, 'UNKNOWN_FLAG'],
    ['rollback non supporté', ['--environment=uat', '--rollback'], env, 'UNKNOWN_FLAG'],
    ['argument positionnel', ['--environment=uat', 'backups'], env, 'UNEXPECTED_ARGUMENT'],
    ['environnement divergent', ['--environment=dev'], env, 'ENVIRONMENT_MISMATCH'],
    ['base divergente', ['--environment=uat'], { ...env, MONGODB_URI: 'mongodb://h/elintys-dev' }, 'DATABASE_MISMATCH'],
    ['sans URI', ['--environment=uat'], { ELINTYS_ENV: 'uat' }, 'MONGODB_URI_REQUIRED'],
    ['production non confirmée', ['--environment=prod'], { MONGODB_URI: 'mongodb://h/elintys', ELINTYS_ENV: 'prod' }, 'PRODUCTION_ACK_REQUIRED'],
  ])('devrait refuser %s AVANT toute connexion', async (_label, argv, runEnv, code) => {
    const events: string[] = [];
    const deps = makeDeps(events);
    await expect(runGuardedMigration(definition(events), argv, { ...runEnv }, deps)).rejects.toThrow(code);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('devrait refuser si la base réellement connectée diffère de la cible', async () => {
    const events: string[] = [];
    const deps = makeDeps(events, 'elintys');
    await expect(runGuardedMigration(definition(events), ['--environment=uat'], { ...env }, deps))
      .rejects.toThrow('CONNECTED_DATABASE_MISMATCH');
    expect(events).not.toContain('run:dry-run');
    expect(events).toContain('disconnect');
  });

  it('devrait accepter la production uniquement avec toutes les confirmations', async () => {
    const events: string[] = [];
    const deps = makeDeps(events, 'elintys');
    const report = await runGuardedMigration(
      definition(events),
      ['--environment=prod', '--confirm-database=elintys', '--backup-path=/secure'],
      { MONGODB_URI: 'mongodb://h/elintys', ELINTYS_ENV: 'prod', ELINTYS_ALLOW_PRODUCTION_MIGRATION: 'I_HAVE_A_VERIFIED_BACKUP' },
      deps,
    );
    expect(report.environment).toBe('prod');
    expect(report.status).toBe('dry-run');
  });
});

describe('resolveMode', () => {
  it('devrait refuser --apply et --rollback ensemble', () => {
    expect(resolveMode(false, false)).toBe('dry-run');
    expect(resolveMode(true, false)).toBe('apply');
    expect(resolveMode(false, true)).toBe('rollback');
    expect(() => resolveMode(true, true)).toThrow('CONFLICTING_FLAGS');
  });
});

describe('script-cli', () => {
  it('devrait analyser strictement les drapeaux', () => {
    const flags = parseCliFlags(['--apply', '--backup-path=/b'], ['apply', 'backup-path']);
    expect(flagEnabled(flags, 'apply')).toBe(true);
    expect(flagValue(flags, 'backup-path')).toBe('/b');
    expect(() => parseCliFlags(['--apply', '--apply'], ['apply'])).toThrow('DUPLICATE_FLAG');
    expect(() => flagValue(parseCliFlags(['--backup-path'], ['backup-path']), 'backup-path')).toThrow('FLAG_VALUE_REQUIRED');
    expect(() => flagEnabled(parseCliFlags(['--apply=yes'], ['apply']), 'apply')).toThrow('FLAG_TAKES_NO_VALUE');
  });

  describe('loadExplicitEnvFile', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'elintys-env-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('devrait charger uniquement le fichier choisi, qui prime sur le shell', () => {
      const file = join(dir, '.env.uat.local');
      writeFileSync(file, 'ELINTYS_ENV=uat\nMONGODB_URI=mongodb://h/elintys-uat\n');
      const target: NodeJS.ProcessEnv = { ELINTYS_ENV: 'dev' };
      loadExplicitEnvFile(file, 'uat', target);
      expect(target).toEqual({ ELINTYS_ENV: 'uat', MONGODB_URI: 'mongodb://h/elintys-uat' });
    });

    it('ne devrait rien charger sans --env-file', () => {
      const target: NodeJS.ProcessEnv = {};
      loadExplicitEnvFile(undefined, 'uat', target);
      expect(target).toEqual({});
    });

    it('devrait refuser un fichier de production hors --environment=prod', () => {
      const file = join(dir, '.env.production');
      writeFileSync(file, 'ELINTYS_ENV=prod\n');
      expect(() => loadExplicitEnvFile(file, 'uat', {})).toThrow('ENV_FILE_PRODUCTION_REFUSED');
    });

    it('devrait refuser un fichier introuvable', () => {
      expect(() => loadExplicitEnvFile(join(dir, 'missing.env'), 'uat', {})).toThrow('ENV_FILE_NOT_FOUND');
    });
  });
});

describe('backupDatabase', () => {
  let dir: string;
  const fakeDb = (databaseName: string): BackupDb => ({
    databaseName,
    listCollections: () => ({
      toArray: async () => [{ name: 'users' }, { name: 'system.views' }, { name: 'events' }],
    }),
    collection: (name: string) => ({
      find: () => ({ toArray: async () => (name === 'users' ? [{ _id: new Types.ObjectId(), email: 'a@uat.elintys.test' }] : []) }),
      indexes: async () => [{ name: '_id_', key: { _id: 1 } }],
    }),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'elintys-backup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('devrait écrire un dump EJSON par collection et un manifeste privé', async () => {
    const result = await backupDatabase(fakeDb('elintys-uat'), {
      target: { environment: 'uat', databaseName: 'elintys-uat', productionConfirmed: false },
      outputRoot: dir,
      clusterHost: 'cluster0.example.mongodb.net',
      tool: 'test',
      now: new Date('2026-09-26T10:00:00.000Z'),
    });
    expect(result.totalDocuments).toBe(1);
    expect(readdirSync(result.directory).sort()).toEqual(['events.json', 'manifest.json', 'manifest.sha256', 'users.json']);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    expect(manifest).toMatchObject({ database: 'elintys-uat', environment: 'uat', cluster: 'cluster0.example.mongodb.net' });
    expect(statSync(result.directory).mode & 0o777).toBe(0o700);
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
  });

  it('devrait refuser la production sans garde production franchie', async () => {
    await expect(backupDatabase(fakeDb('elintys'), {
      target: { environment: 'prod', databaseName: 'elintys', productionConfirmed: false },
      outputRoot: dir,
      clusterHost: 'h',
      tool: 'test',
    })).rejects.toThrow('BACKUP_PRODUCTION_REFUSED');
  });

  it('devrait refuser une base connectée différente de la cible', async () => {
    await expect(backupDatabase(fakeDb('elintys'), {
      target: { environment: 'uat', databaseName: 'elintys-uat', productionConfirmed: false },
      outputRoot: dir,
      clusterHost: 'h',
      tool: 'test',
    })).rejects.toThrow('BACKUP_DATABASE_MISMATCH');
  });

  it('devrait refuser un dump commitable dans le dépôt hors backups/', async () => {
    const options = {
      target: { environment: 'uat' as const, databaseName: 'elintys-uat', productionConfirmed: false },
      clusterHost: 'h',
      tool: 'test',
      repositoryRoot: dir,
    };
    await expect(backupDatabase(fakeDb('elintys-uat'), { ...options, outputRoot: join(dir, 'src') }))
      .rejects.toThrow('BACKUP_PATH_INSIDE_REPOSITORY');
    await expect(backupDatabase(fakeDb('elintys-uat'), { ...options, outputRoot: join(dir, 'backups') }))
      .resolves.toMatchObject({ totalDocuments: 1 });
  });
});
