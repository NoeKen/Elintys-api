import mongoose from 'mongoose';
import { backupDatabase, BackupCollection, BackupDb } from './lib/database-backup';
import { GuardedTarget, ScriptGuardError, UAT_DATABASE_NAME, formatSafeError } from './lib/environment-guard';
import { flagEnabled, flagValue, parseCliFlags, requireExplicitEnvFile } from './lib/script-cli';
import {
  UAT_SEED_PASSWORD_ENV,
  assertSeedPassword,
  connectUat,
  printSeedSummary,
  resolveUatConnection,
  seedUatDatabase,
} from './seed-uat';

/**
 * reset-uat.ts — vide les collections applicatives de la base de recette.
 *
 *   npm run reset:uat -- --env-file=.env.uat.local --confirm=elintys-uat --backup-path=<dir> [--reseed]
 *   npm run reset:uat -- --env-file=.env.uat.local --confirm=elintys-uat --skip-backup [--reseed]
 *
 * Refus (avant toute connexion) : ELINTYS_ENV ≠ uat, base ≠ `elintys-uat`,
 * tout nom contenant `prod`, `--confirm` absent ou différent de `elintys-uat`,
 * absence de backup sans `--skip-backup` explicite, `--reseed` sans mot de
 * passe de seed valide.
 *
 * Effet : `deleteMany({})` sur chaque collection (hors `system.*` et vues).
 * Les collections et leurs index sont CONSERVÉS ; la base n'est jamais supprimée.
 */

export interface ResetPlan {
  uri: string;
  clusterHost: string;
  target: GuardedTarget;
  backupPath: string | undefined;
  reseed: boolean;
  seedPassword: string | undefined;
}

export function planReset(argv: readonly string[], env: NodeJS.ProcessEnv): ResetPlan {
  const flags = parseCliFlags(argv, ['env-file', 'confirm', 'backup-path', 'skip-backup', 'reseed']);
  requireExplicitEnvFile(flagValue(flags, 'env-file'), 'uat', env);
  const { uri, clusterHost, target } = resolveUatConnection(env);
  if (flagValue(flags, 'confirm') !== UAT_DATABASE_NAME) {
    throw new ScriptGuardError('RESET_CONFIRMATION_REQUIRED', `--confirm=${UAT_DATABASE_NAME} est obligatoire`);
  }
  const skipBackup = flagEnabled(flags, 'skip-backup');
  const backupPath = flagValue(flags, 'backup-path');
  if (skipBackup && backupPath) {
    throw new ScriptGuardError('CONFLICTING_FLAGS', '--skip-backup et --backup-path sont mutuellement exclusifs');
  }
  if (!skipBackup && !backupPath) {
    throw new ScriptGuardError('BACKUP_PATH_REQUIRED', '--backup-path=<dir> (ou --skip-backup explicite)');
  }
  const reseed = flagEnabled(flags, 'reseed');
  // Vérifié AVANT la suppression : un reseed impossible ne doit pas laisser une base vide.
  const seedPassword = reseed ? assertSeedPassword(env[UAT_SEED_PASSWORD_ENV]) : undefined;
  return { uri, clusterHost, target, backupPath, reseed, seedPassword };
}

export interface ResettableDb extends BackupDb {
  collection(name: string): BackupCollection & {
    deleteMany(filter: Record<string, never>): Promise<{ deletedCount?: number }>;
  };
}

export async function clearCollections(db: ResettableDb): Promise<Record<string, number>> {
  if (db.databaseName !== UAT_DATABASE_NAME) {
    throw new ScriptGuardError('CONNECTED_DATABASE_MISMATCH', `base connectée '${db.databaseName}'`);
  }
  const collections = (await db.listCollections().toArray())
    .filter(({ name, type }) => !name.startsWith('system.') && type !== 'view')
    .map(({ name }) => name)
    .sort();
  const deleted: Record<string, number> = {};
  for (const name of collections) {
    const result = await db.collection(name).deleteMany({});
    deleted[name] = result.deletedCount ?? 0;
  }
  return deleted;
}

async function main(argv: readonly string[]): Promise<void> {
  const plan = planReset(argv, process.env);
  console.log(
    `[reset:uat] cible : cluster=${plan.clusterHost} base=${plan.target.databaseName} ` +
      `backup=${plan.backupPath ? 'oui' : 'IGNORÉ (--skip-backup)'} reseed=${plan.reseed ? 'oui' : 'non'}`,
  );
  const connection = await connectUat(plan.uri, plan.target);
  try {
    const db = connection.db as unknown as ResettableDb;
    if (plan.backupPath) {
      const backup = await backupDatabase(db, {
        target: plan.target,
        outputRoot: plan.backupPath,
        clusterHost: plan.clusterHost,
        tool: 'reset-uat.ts (backup pré-reset, EJSON)',
      });
      console.log(`[reset:uat] backup : ${backup.totalDocuments} documents → ${backup.directory}`);
    }
    const deleted = await clearCollections(db);
    console.table(deleted);
    console.log(`[reset:uat] ${Object.values(deleted).reduce((a, b) => a + b, 0)} documents supprimés ; collections et index conservés.`);
    if (plan.reseed && plan.seedPassword) {
      printSeedSummary(await seedUatDatabase(connection, plan.seedPassword));
    }
  } finally {
    await mongoose.disconnect();
  }
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[reset:uat] ÉCHEC ${formatSafeError(error)}`);
    process.exitCode = 1;
  });
}
