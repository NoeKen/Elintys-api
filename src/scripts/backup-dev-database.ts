import 'dotenv/config';
import { join } from 'path';
import mongoose from 'mongoose';
import { backupDatabase, BackupDb } from './lib/database-backup';
import { describeMongoUri, formatSafeError, REQUIRED_DB_NAME } from './lib/environment-guard';

/**
 * backup-dev-database.ts — sauvegarde complète de la base **dev** (Lot 3, phase A).
 *
 * Contrat historique conservé : `npm run backup:dev -- [répertoire de sortie]`.
 * La logique (EJSON + manifeste SHA-256) vit dans `lib/database-backup.ts`,
 * partagée avec le runner de migrations et `backup-database.ts` (dev/uat).
 *
 * Sécurité : REFUSE toute base qui n'est pas exactement `elintys-dev`.
 */

async function backup(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('BACKUP_REFUSED: MONGODB_URI requis.');
  const described = describeMongoUri(mongoUri);
  if (described.databaseName !== REQUIRED_DB_NAME) {
    throw new Error(`BACKUP_REFUSED: la base doit être exactement "${REQUIRED_DB_NAME}".`);
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('BACKUP_REFUSED: connexion indisponible.');
    const result = await backupDatabase(db as unknown as BackupDb, {
      target: { environment: 'dev', databaseName: REQUIRED_DB_NAME, productionConfirmed: false },
      outputRoot: process.argv[2] ?? join(process.cwd(), 'backups'),
      clusterHost: described.clusterHost,
      tool: 'backup-dev-database.ts (EJSON, driver Node)',
    });
    console.log(`✓ Backup "${REQUIRED_DB_NAME}" → ${result.directory}`);
    console.table(result.collections.map((r) => ({ collection: r.collection, documents: r.documents, sha256: `${r.sha256.slice(0, 16)}…` })));
    console.log(`Total: ${result.totalDocuments} documents dans ${result.collections.length} collections.`);
  } finally {
    await mongoose.disconnect();
  }
}

backup().catch((error: unknown) => {
  console.error('ÉCHEC backup:', formatSafeError(error));
  process.exitCode = 1;
});
