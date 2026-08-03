import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import {
  AdmissionMode,
  EventAccessPolicy,
  EventDiscoverability,
  EventVisibility,
} from '../modules/events/event.schema';
import {
  LegacyAmbiguityReason,
  mapLegacyEventAccessToV2,
} from '../modules/events/event-access.policy';
import {
  ElintysEnvironment,
  resolveElintysEnvironment,
} from '../config/elintys-environment';

/** Base de développement autorisée — toute autre base est refusée (finding F-029). */
const REQUIRED_DEV_DATABASE = 'elintys-dev';

type LegacyEvent = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  visibility?: EventVisibility;
  accessRules?: {
    accessCode?: boolean;
    allowedEmailDomain?: string;
    manualApproval?: boolean;
  };
  accessModelVersion?: number;
};

type MigrationUpdate = {
  accessModelVersion: number;
  discoverability: EventDiscoverability;
  accessPolicy: EventAccessPolicy;
  admissionModes: AdmissionMode[];
};

type MigrationPlan = {
  eventId: mongoose.Types.ObjectId;
  legacyVisibility: EventVisibility | undefined;
  update?: MigrationUpdate;
  ambiguousReason?: LegacyAmbiguityReason;
};

/**
 * Extrait le nom de base d'une URI MongoDB.
 * Retourne `undefined` si l'URI est invalide ou ne nomme aucune base.
 */
export function extractDatabaseName(mongoUri: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(mongoUri).pathname;
  } catch {
    return undefined;
  }
  const name = decodeURIComponent(pathname.replace(/^\//, '')).trim();
  return name.length > 0 ? name : undefined;
}

/**
 * Garde dure exécutée **avant toute connexion** (finding F-029).
 * Refuse : environnement non-dev, URI absente/invalide, base sans nom explicite,
 * et toute base différente de `elintys-dev` (notamment la production `elintys`).
 */
export function assertEventAccessMigrationAllowed(
  elintysEnvironment: ElintysEnvironment,
  mongoUri: string | undefined,
): asserts mongoUri is string {
  if (elintysEnvironment !== 'dev') {
    throw new Error('MIGRATION_REFUSED: ELINTYS_ENV must be exactly "dev".');
  }
  if (!mongoUri) {
    throw new Error('MIGRATION_REFUSED: MONGODB_URI is required.');
  }
  const databaseName = extractDatabaseName(mongoUri);
  if (!databaseName) {
    throw new Error('MIGRATION_REFUSED: MONGODB_URI must name an explicit database.');
  }
  if (databaseName !== REQUIRED_DEV_DATABASE) {
    throw new Error(
      `MIGRATION_REFUSED: database must be exactly "${REQUIRED_DEV_DATABASE}" (received "${databaseName}").`,
    );
  }
}

/**
 * Plan de migration d'un document legacy.
 * Délègue **entièrement** à `mapLegacyEventAccessToV2` (source de vérité partagée
 * avec la normalisation runtime) : aucune logique de mapping dupliquée ici (F-027).
 */
export function planEventAccessMigration(event: LegacyEvent): MigrationPlan {
  const mapping = mapLegacyEventAccessToV2(event);
  if (mapping.status === 'ambiguous') {
    return {
      eventId: event._id,
      legacyVisibility: event.visibility,
      ambiguousReason: mapping.reason,
    };
  }
  return {
    eventId: event._id,
    legacyVisibility: event.visibility,
    update: { accessModelVersion: 2, ...mapping.value },
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const elintysEnvironment = resolveElintysEnvironment(
    process.env.ELINTYS_ENV,
    process.env.NODE_ENV ?? 'development',
  );
  // Garde AVANT toute connexion.
  assertEventAccessMigrationAllowed(elintysEnvironment, uri);

  await mongoose.connect(uri);
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB connection is unavailable');
  // Seconde garde : nom réel de la base après connexion.
  if (database.databaseName !== REQUIRED_DEV_DATABASE) {
    throw new Error(
      `MIGRATION_REFUSED: connected database "${database.databaseName}" != "${REQUIRED_DEV_DATABASE}".`,
    );
  }
  const collection = database.collection<LegacyEvent>('events');

  const events = await collection.find({ accessModelVersion: { $ne: 2 } }).toArray();
  const plans = events.map(planEventAccessMigration);
  const executable = plans.filter((plan) => plan.update);
  const ambiguous = plans.filter((plan) => plan.ambiguousReason);
  const byVisibility = Object.fromEntries(
    Object.values(EventVisibility).map((visibility) => [
      visibility,
      plans.filter((plan) => plan.legacyVisibility === visibility).length,
    ]),
  );
  const report = {
    mode: process.argv.includes('--execute') ? 'execute' : 'dry-run',
    database: database.databaseName,
    total: events.length,
    mapping: byVisibility,
    migratable: executable.length,
    ambiguous: ambiguous.length,
    ambiguousEvents: ambiguous.map((plan) => ({
      eventId: plan.eventId.toString(),
      reason: plan.ambiguousReason,
    })),
  };

  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!process.argv.includes('--confirm-access-v2')) {
    throw new Error('MIGRATION_REFUSED: add --confirm-access-v2 after reviewing the dry-run report.');
  }

  const rollbackFile = `event-access-v2-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    rollbackFile,
    JSON.stringify(events.map((event) => ({
      _id: event._id.toString(),
      visibility: event.visibility,
      accessRules: event.accessRules,
      accessModelVersion: event.accessModelVersion,
    })), null, 2),
    { flag: 'wx', mode: 0o600 },
  );

  let migrated = 0;
  for (const plan of executable) {
    const result = await collection.updateOne(
      { _id: plan.eventId, accessModelVersion: { $ne: 2 } },
      { $set: plan.update! },
    );
    migrated += result.modifiedCount;
  }
  console.log(JSON.stringify({ ...report, migrated, rollbackFile }, null, 2));
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Unknown migration error');
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect());
}
