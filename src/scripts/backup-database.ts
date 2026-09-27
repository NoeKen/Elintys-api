import mongoose from 'mongoose';
import { backupDatabase, BackupDb } from './lib/database-backup';
import {
  PRODUCTION_ACK_ENV,
  ScriptGuardError,
  assertConnectedDatabase,
  describeMongoUri,
  formatSafeError,
  resolveGuardedTarget,
} from './lib/environment-guard';
import { flagValue, loadExplicitEnvFile, parseCliFlags } from './lib/script-cli';

/**
 * backup-database.ts — backup EJSON complet (lecture seule) d'un environnement gardé.
 *
 *   npm run backup:db -- --environment=<dev|uat> --backup-path=<dir> [--env-file=.env.uat.local]
 *
 * Même garde que les migrations (lib/environment-guard.ts) : la production est
 * refusée sauf confirmations explicites complètes.
 */
async function main(argv: readonly string[]): Promise<void> {
  const flags = parseCliFlags(argv, ['environment', 'env-file', 'backup-path', 'confirm-database']);
  const cliEnvironment = flagValue(flags, 'environment');
  const backupPath = flagValue(flags, 'backup-path');
  loadExplicitEnvFile(flagValue(flags, 'env-file'), cliEnvironment);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new ScriptGuardError('MONGODB_URI_REQUIRED', 'aucune connexion tentée');
  const described = describeMongoUri(uri);
  const target = resolveGuardedTarget({
    cliEnvironment,
    elintysEnv: process.env.ELINTYS_ENV,
    databaseName: described.databaseName,
    writes: true,
    backupPath,
    confirmDatabase: flagValue(flags, 'confirm-database'),
    productionAck: process.env[PRODUCTION_ACK_ENV],
  });
  console.log(`[backup] cible : environnement=${target.environment} cluster=${described.clusterHost} base=${target.databaseName}`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000, autoIndex: false });
  try {
    assertConnectedDatabase(target, mongoose.connection.db?.databaseName);
    const result = await backupDatabase(mongoose.connection.db as unknown as BackupDb, {
      target,
      outputRoot: backupPath as string,
      clusterHost: described.clusterHost,
      tool: 'backup-database.ts (EJSON, driver Node)',
    });
    console.log(`[backup] ${result.totalDocuments} documents / ${result.collections.length} collections → ${result.directory}`);
  } finally {
    await mongoose.disconnect();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`[backup] ÉCHEC ${formatSafeError(error)}`);
  process.exitCode = 1;
});
