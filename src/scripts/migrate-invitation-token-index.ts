import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { assertEventAccessMigrationAllowed } from './migrate-event-access-v2';
import { resolveElintysEnvironment } from '../config/elintys-environment';

/**
 * migrate-invitation-token-index.ts — correctif F-028.
 *
 * 1. `$unset` du champ legacy `token` (jeton brut stocké en base) ;
 * 2. suppression de l'index legacy `token_1` (UNIQUE **non-sparse**) qui provoquait
 *    un E11000 dès la 2ᵉ invitation créée, faute de champ `token` renseigné.
 *
 * `tokenHash_1` (UNIQUE) reste la contrainte d'unicité réelle, et l'index métier
 * `invitedBy_1_email_1_eventId_1_type_1` est conservé.
 *
 * Sécurité : réutilise la garde d'environnement de la migration Access V2 —
 * refuse tout ce qui n'est pas `ELINTYS_ENV=dev` + base exactement `elintys-dev`.
 * Dry-run par défaut ; écriture uniquement avec `--execute --confirm-token-index`.
 */

const REQUIRED_DEV_DATABASE = 'elintys-dev';
const LEGACY_INDEX = 'token_1';
const PROTECTED_INDEXES = [
  '_id_',
  'tokenHash_1',
  'expiresAt_1',
  'invitedBy_1_email_1_eventId_1_type_1',
  'invitedBy_1_email_1',
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
  const legacyIndex = indexesBefore.find((index) => index.name === LEGACY_INDEX);
  const documentsWithToken = await collection.countDocuments({ token: { $exists: true } });

  const report = {
    mode: process.argv.includes('--execute') ? 'execute' : 'dry-run',
    database: database.databaseName,
    documentsWithLegacyToken: documentsWithToken,
    legacyIndexPresent: Boolean(legacyIndex),
    indexesBefore: indexesBefore.map((index) => index.name),
  };

  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    return;
  }
  if (!process.argv.includes('--confirm-token-index')) {
    throw new Error(
      'MIGRATION_REFUSED: add --confirm-token-index after reviewing the dry-run report.',
    );
  }

  // Sauvegarde de rollback : documents concernés + définitions d'index.
  const affected = await collection
    .find({ token: { $exists: true } }, { projection: { _id: 1, token: 1 } })
    .toArray();
  const rollbackFile = `invitation-token-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    rollbackFile,
    JSON.stringify(
      {
        database: database.databaseName,
        indexesBefore,
        documents: affected.map((doc) => ({ _id: doc._id.toString(), token: doc.token })),
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );

  const unsetResult = await collection.updateMany(
    { token: { $exists: true } },
    { $unset: { token: '' } },
  );

  let droppedIndex = false;
  if (legacyIndex) {
    await collection.dropIndex(LEGACY_INDEX);
    droppedIndex = true;
  }

  const indexesAfter = await collection.indexes();
  const removed = indexesBefore
    .map((index) => index.name)
    .filter((name) => !indexesAfter.some((index) => index.name === name));
  const unexpectedlyRemoved = removed.filter(
    (name) => name !== LEGACY_INDEX && PROTECTED_INDEXES.includes(name ?? ''),
  );
  if (unexpectedlyRemoved.length > 0) {
    throw new Error(
      `MIGRATION_ANOMALY: index protégé supprimé — ${unexpectedlyRemoved.join(', ')}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ...report,
        tokensUnset: unsetResult.modifiedCount,
        droppedIndex,
        indexesAfter: indexesAfter.map((index) => index.name),
        removedIndexes: removed,
        rollbackFile,
      },
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
