import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { assertEventAccessMigrationAllowed } from './migrate-event-access-v2';
import { resolveElintysEnvironment } from '../config/elintys-environment';

/**
 * migrate-invitation-dedup-index.ts — correctif F-032.
 *
 * Supprime l'index orphelin `invitedBy_1_email_1` (UNIQUE), absent du schéma Mongoose
 * et **plus strict** que la règle de déduplication métier réelle
 * `{ invitedBy, email, eventId, type }` : il empêchait d'inviter la même adresse
 * pour deux événements — ou deux types — différents.
 *
 * Aucun document n'est modifié : l'opération ne touche qu'un index.
 *
 * Sécurité : garde d'environnement (dev + base exactement `elintys-dev`),
 * dry-run par défaut, écriture avec `--execute --confirm-dedup-index`.
 */

const REQUIRED_DEV_DATABASE = 'elintys-dev';
const LEGACY_INDEX = 'invitedBy_1_email_1';
const PROTECTED_INDEXES = [
  '_id_',
  'expiresAt_1',
  'tokenHash_1',
  'invitedBy_1_email_1_eventId_1_type_1',
];

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const elintysEnvironment = resolveElintysEnvironment(
    process.env.ELINTYS_ENV,
    process.env.NODE_ENV ?? 'development',
  );
  assertEventAccessMigrationAllowed(elintysEnvironment, uri);

  await mongoose.connect(uri);
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB connection is unavailable');
  if (database.databaseName !== REQUIRED_DEV_DATABASE) {
    throw new Error(
      `MIGRATION_REFUSED: connected database "${database.databaseName}" != "${REQUIRED_DEV_DATABASE}".`,
    );
  }

  const collection = database.collection('invitations');
  const indexesBefore = await collection.indexes();
  const namesBefore = indexesBefore.map((index) => index.name);
  const legacyIndex = indexesBefore.find((index) => index.name === LEGACY_INDEX);

  // Garde : l'index métier à 4 champs doit exister avant de retirer le legacy.
  const businessIndexPresent = namesBefore.includes('invitedBy_1_email_1_eventId_1_type_1');
  if (!businessIndexPresent) {
    throw new Error(
      "MIGRATION_REFUSED: l'index métier invitedBy_1_email_1_eventId_1_type_1 est absent — suppression annulée.",
    );
  }

  const report = {
    mode: process.argv.includes('--execute') ? 'execute' : 'dry-run',
    database: database.databaseName,
    legacyIndexPresent: Boolean(legacyIndex),
    businessIndexPresent,
    documents: await collection.countDocuments(),
    indexesBefore: namesBefore,
  };

  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    return;
  }
  if (!process.argv.includes('--confirm-dedup-index')) {
    throw new Error(
      'MIGRATION_REFUSED: add --confirm-dedup-index after reviewing the dry-run report.',
    );
  }
  // Garde : rien à faire si l'index attendu n'existe pas — arrêt propre.
  if (!legacyIndex) {
    console.log(JSON.stringify({ ...report, skipped: 'LEGACY_INDEX_ABSENT' }, null, 2));
    await mongoose.disconnect();
    return;
  }

  const rollbackFile = `invitation-dedup-index-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    rollbackFile,
    JSON.stringify(
      { database: database.databaseName, droppedIndex: legacyIndex, indexesBefore },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );

  await collection.dropIndex(LEGACY_INDEX);

  const indexesAfter = await collection.indexes();
  const namesAfter = indexesAfter.map((index) => index.name);
  const removed = namesBefore.filter((name) => !namesAfter.includes(name));

  // Garde anti-anomalie : aucun index protégé ne doit avoir disparu.
  const missingProtected = PROTECTED_INDEXES.filter((name) => !namesAfter.includes(name));
  if (missingProtected.length > 0) {
    throw new Error(
      `MIGRATION_ANOMALY: index protégé manquant après opération — ${missingProtected.join(', ')}`,
    );
  }
  if (removed.length !== 1 || removed[0] !== LEGACY_INDEX) {
    throw new Error(
      `MIGRATION_ANOMALY: suppression inattendue — attendu [${LEGACY_INDEX}], observé [${removed.join(', ')}]`,
    );
  }

  console.log(
    JSON.stringify(
      { ...report, droppedIndex: true, indexesAfter: namesAfter, removedIndexes: removed, rollbackFile },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unknown migration error');
    process.exitCode = 1;
    void mongoose.disconnect();
  });
}
