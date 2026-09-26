import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { BackupDb, BackupResult, backupDatabase } from './database-backup';
import {
  GuardedTarget,
  PRODUCTION_ACK_ENV,
  ScriptGuardError,
  assertConnectedDatabase,
  describeMongoUri,
  formatSafeError,
  resolveGuardedTarget,
} from './environment-guard';
import { flagEnabled, flagValue, loadExplicitEnvFile, parseCliFlags } from './script-cli';

/**
 * migration-runner.ts — contrat unique des scripts de migration.
 *
 *   npm run <migration> -- --environment=<dev|uat|prod> [--env-file=<fichier>]
 *                          [--apply | --rollback] [--backup-path=<dir>]
 *                          [--confirm-database=<nom>]
 *
 *   - dry-run par défaut (aucune écriture) ;
 *   - --apply / --rollback exigent --backup-path ;
 *   - la cible (hôte du cluster sans identifiants + nom de base) est affichée
 *     AVANT toute connexion ;
 *   - en écriture : backup complet → migration → post-validation → rapport
 *     JSON `migration-report.json` écrit à côté du backup.
 */

export type MigrationMode = 'dry-run' | 'apply' | 'rollback';

export interface PostValidation {
  passed: boolean;
  checks: Record<string, unknown>;
  errors: string[];
}

export interface MigrationOutcome {
  preflight: unknown;
  changes?: unknown;
  postValidation?: PostValidation;
}

export interface MigrationContext {
  db: Db;
  mode: MigrationMode;
  target: GuardedTarget;
}

export interface MigrationDefinition {
  name: string;
  supportsRollback?: boolean;
  run(context: MigrationContext): Promise<MigrationOutcome>;
}

export interface MigrationReport {
  migration: string;
  status: 'dry-run' | 'succeeded' | 'failed';
  mode: MigrationMode;
  environment: GuardedTarget['environment'];
  database: string;
  clusterHost: string;
  startedAt: string;
  finishedAt: string;
  backup: { directory: string; totalDocuments: number; collections: number } | null;
  outcome: MigrationOutcome | null;
  error: string | null;
}

export interface RunnerDependencies {
  connect(uri: string): Promise<Db>;
  disconnect(): Promise<void>;
  backup(db: BackupDb, options: Parameters<typeof backupDatabase>[1]): Promise<BackupResult>;
  writeReport(path: string, content: string): Promise<void>;
  log(line: string): void;
}

export const defaultRunnerDependencies: RunnerDependencies = {
  async connect(uri) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000, autoIndex: false });
    const db = mongoose.connection.db;
    if (!db) throw new ScriptGuardError('CONNECTION_FAILED', 'mongoose.connection.db indisponible');
    return db as unknown as Db;
  },
  disconnect: () => mongoose.disconnect(),
  backup: backupDatabase,
  writeReport: (path, content) => writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  log: (line) => console.log(line),
};

const BASE_FLAGS = ['environment', 'env-file', 'apply', 'backup-path', 'confirm-database'] as const;

export function resolveMode(apply: boolean, rollback: boolean): MigrationMode {
  if (apply && rollback) {
    throw new ScriptGuardError('CONFLICTING_FLAGS', '--apply et --rollback sont mutuellement exclusifs');
  }
  if (rollback) return 'rollback';
  return apply ? 'apply' : 'dry-run';
}

export async function runGuardedMigration(
  definition: MigrationDefinition,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: RunnerDependencies = defaultRunnerDependencies,
): Promise<MigrationReport> {
  const allowed = definition.supportsRollback ? [...BASE_FLAGS, 'rollback'] : [...BASE_FLAGS];
  const flags = parseCliFlags(argv, allowed);
  const mode = resolveMode(flagEnabled(flags, 'apply'), flagEnabled(flags, 'rollback'));
  const cliEnvironment = flagValue(flags, 'environment');
  const backupPath = flagValue(flags, 'backup-path');

  loadExplicitEnvFile(flagValue(flags, 'env-file'), cliEnvironment, env);
  const uri = env.MONGODB_URI;
  if (!uri) throw new ScriptGuardError('MONGODB_URI_REQUIRED', 'aucune connexion tentée');
  const described = describeMongoUri(uri);

  const target = resolveGuardedTarget({
    cliEnvironment,
    elintysEnv: env.ELINTYS_ENV,
    databaseName: described.databaseName,
    writes: mode !== 'dry-run',
    backupPath,
    confirmDatabase: flagValue(flags, 'confirm-database'),
    productionAck: env[PRODUCTION_ACK_ENV],
  });

  deps.log(
    `[${definition.name}] cible : environnement=${target.environment} cluster=${described.clusterHost} ` +
      `base=${target.databaseName} mode=${mode}`,
  );

  const report: MigrationReport = {
    migration: definition.name,
    status: mode === 'dry-run' ? 'dry-run' : 'succeeded',
    mode,
    environment: target.environment,
    database: target.databaseName,
    clusterHost: described.clusterHost,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    backup: null,
    outcome: null,
    error: null,
  };

  const db = await deps.connect(uri);
  let backup: BackupResult | null = null;
  try {
    assertConnectedDatabase(target, db.databaseName);

    if (mode !== 'dry-run') {
      backup = await deps.backup(db as unknown as BackupDb, {
        target,
        outputRoot: backupPath as string,
        clusterHost: described.clusterHost,
        tool: `${definition.name} (backup pré-migration, EJSON)`,
      });
      report.backup = {
        directory: backup.directory,
        totalDocuments: backup.totalDocuments,
        collections: backup.collections.length,
      };
      deps.log(`[${definition.name}] backup : ${backup.totalDocuments} documents → ${backup.directory}`);
    }

    try {
      report.outcome = await definition.run({ db, mode, target });
      if (mode !== 'dry-run' && report.outcome.postValidation && !report.outcome.postValidation.passed) {
        throw new ScriptGuardError('POST_VALIDATION_FAILED', report.outcome.postValidation.errors.join(' | '));
      }
    } catch (error) {
      report.status = 'failed';
      report.error = formatSafeError(error);
      throw error;
    } finally {
      report.finishedAt = new Date().toISOString();
      if (backup) {
        const reportPath = join(backup.directory, 'migration-report.json');
        await deps.writeReport(reportPath, JSON.stringify(report, null, 2));
        deps.log(`[${definition.name}] rapport : ${reportPath}`);
      }
    }
  } finally {
    await deps.disconnect();
  }

  deps.log(JSON.stringify(report.outcome, null, 2));
  deps.log(
    `[${definition.name}] résumé : statut=${report.status} mode=${mode} base=${target.databaseName}` +
      (mode === 'dry-run' ? ' — aucune écriture (ajouter --apply --backup-path=<dir> pour appliquer)' : ''),
  );
  return report;
}

/** Point d'entrée CLI commun : n'imprime que des messages sûrs, jamais l'URI. */
export function runMigrationCli(definition: MigrationDefinition): void {
  runGuardedMigration(definition, process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[${definition.name}] ÉCHEC ${formatSafeError(error)} — aucune restauration automatique (rapport écrit à côté du backup s'il a été créé).`);
    process.exitCode = 1;
  });
}
