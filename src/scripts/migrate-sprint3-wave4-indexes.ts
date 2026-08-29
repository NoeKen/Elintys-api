import 'dotenv/config';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';

/**
 * migrate-sprint3-wave4-indexes.ts — Critical Operations Wave 4.
 *
 * Crée les indexes MongoDB des schémas Wave 4 (`autoIndex: false`) via
 * une migration contrôlée à trois modes :
 *
 *   dry-run  (défaut)   — préflight read-only + résumé JSON, aucune écriture.
 *   --apply             — création idempotente + vérification post-apply.
 *   --rollback          — suppression ciblée UNIQUEMENT des indexes de cette migration.
 *
 * Gardes strictes appliquées AVANT toute écriture :
 *   - `ELINTYS_ENV === 'dev'`
 *   - Nom de la base MongoDB connectée === `elintys-dev`
 *
 * L'URI Mongo n'est JAMAIS lue ni logguée en clair.
 *
 * Pré-requis : backup de la base `elintys-dev` déjà réalisé
 * (script existant : `npm run backup:dev`).
 *
 * Rollback documenté :
 *   Chaque index créé par ce script porte un `name` explicite ci-dessous
 *   (`INDEXES`). Le mode `--rollback` supprime UNIQUEMENT ces noms — jamais
 *   les indexes hors de la liste (protection contre les drop accidentels).
 *
 * Note importante :
 *   `event_reg_unique_guest` n'est PAS créé. L'inscription EventRegistration
 *   est authentifiée (participantId obligatoire) — aucun guestEmail n'est
 *   persisté depuis la Wave 4.
 */

export const REQUIRED_ELINTYS_ENV = 'dev';
export const REQUIRED_DB_NAME = 'elintys-dev';

export type MigrationMode = 'dry-run' | 'apply' | 'rollback';

export interface IndexSpec {
  collection: string;
  name: string;
  keys: Record<string, 1 | -1>;
  options: {
    unique?: boolean;
    sparse?: boolean;
    partialFilterExpression?: Record<string, unknown>;
    expireAfterSeconds?: number;
  };
  description: string;
}

/**
 * Liste exhaustive et immuable des indexes gérés par cette migration.
 * Toute modification exige une nouvelle migration Wave.
 */
export const INDEXES: readonly IndexSpec[] = [
  {
    collection: 'event_registrations',
    name: 'event_reg_by_event',
    keys: { eventId: 1, status: 1 },
    options: {},
    description: 'Listing organisateur par événement + status',
  },
  {
    collection: 'event_registrations',
    name: 'event_reg_by_participant',
    keys: { participantId: 1, status: 1 },
    options: { sparse: true },
    description: 'Recherche « mes inscriptions »',
  },
  {
    collection: 'event_registrations',
    name: 'event_reg_unique_participant',
    keys: { eventId: 1, participantId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        participantId: { $type: 'objectId' },
        status: 'active',
      },
    },
    description: 'Contrainte : UN participant + UN événement = UNE inscription ACTIVE',
  },
  {
    collection: 'idempotent_operations',
    name: 'idempotent_ops_unique',
    keys: { scope: 1, actorId: 1, keyHash: 1 },
    options: { unique: true },
    description: 'Garantie idempotence multi-instance : (scope, actorId, keyHash) unique',
  },
  {
    collection: 'idempotent_operations',
    name: 'idempotent_ops_ttl',
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    description: 'TTL 90 jours sur les états terminaux (rétention bornée)',
  },
  {
    collection: 'stripe_payment_finalizations',
    name: 'stripe_finalization_unique_pi',
    keys: { stripePaymentIntentId: 1 },
    options: { unique: true },
    description: 'Contrainte permanente : UNE PaymentIntent = UNE finalisation',
  },
] as const;

// ── Fonctions pures ─────────────────────────────────────────────────────────

export function parseMode(argv: readonly string[]): MigrationMode {
  const hasApply = argv.includes('--apply');
  const hasRollback = argv.includes('--rollback');
  if (hasApply && hasRollback) {
    throw new Error('CONFLICTING_FLAGS: --apply et --rollback sont mutuellement exclusifs');
  }
  if (hasRollback) return 'rollback';
  if (hasApply) return 'apply';
  return 'dry-run';
}

export function assertEnvironmentGuards(
  elintysEnv: string | undefined,
  dbName: string | undefined,
): void {
  if (elintysEnv !== REQUIRED_ELINTYS_ENV) {
    throw new Error(
      `ENV_GUARD_FAILED: ELINTYS_ENV doit être exactement '${REQUIRED_ELINTYS_ENV}' (reçu: '${elintysEnv ?? 'undefined'}')`,
    );
  }
  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `DB_GUARD_FAILED: la base connectée doit être exactement '${REQUIRED_DB_NAME}' (reçu: '${dbName ?? 'undefined'}')`,
    );
  }
}

// ── Types de rapports ───────────────────────────────────────────────────────

export interface ExistingIndexInfo {
  name: string;
  /** MongoDB's listIndexes() field is `key`; `keys` is retained for test compatibility. */
  key?: Record<string, unknown>;
  keys?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  expireAfterSeconds?: number;
}

export interface CollectionStatus {
  exists: boolean;
  documentCount: number | null;
  existingIndexes: ExistingIndexInfo[];
}

export interface InvalidDocumentReport {
  collection: string;
  invalidDocuments: number;
  rule: string;
}

export interface BlockingDuplicateReport {
  indexName: string;
  collection: string;
  conflictingGroups: number;
}

export interface PreflightReport {
  environment: {
    elintysEnv: string;
    dbName: string;
    replicaSet: {
      isReplicaSet: boolean;
      setName: string | null;
      sessionsAvailable: boolean;
      writablePrimary: boolean;
      transactionsAvailable: boolean;
    };
  };
  collections: Record<string, CollectionStatus>;
  indexPlan: {
    name: string;
    collection: string;
    action: 'create' | 'already-present' | 'conflict';
    conflictReason?: string;
  }[];
  blockingDuplicates: BlockingDuplicateReport[];
  invalidDocuments: InvalidDocumentReport[];
  summary: {
    totalIndexes: number;
    toCreate: number;
    alreadyPresent: number;
    conflicts: number;
    blockingDuplicates: number;
    invalidDocuments: number;
  };
}

export interface ApplyReport {
  created: string[];
  alreadyPresent: string[];
  verificationPassed: boolean;
  verificationErrors: string[];
}

export interface RollbackReport {
  dropped: string[];
  notPresent: string[];
  errors: { indexName: string; error: string }[];
}

// ── Fonctions Db-taking (testables via FakeDb) ──────────────────────────────

/** Interface minimale du Db mongodb utilisée par ce script. */
export type MinimalCollection = {
  listIndexes: () => { toArray: () => Promise<ExistingIndexInfo[]> };
  createIndex: (
    keys: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<string>;
  dropIndex: (name: string) => Promise<unknown>;
  countDocuments: (filter?: Record<string, unknown>) => Promise<number>;
  aggregate: (pipeline: unknown[]) => { toArray: () => Promise<unknown[]> };
};

export type MinimalDb = {
  databaseName: string;
  admin: () => { command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> };
  listCollections: (filter?: Record<string, unknown>) => {
    toArray: () => Promise<{ name: string }[]>;
  };
  collection: (name: string) => MinimalCollection;
};

export async function detectReplicaSet(
  db: MinimalDb,
): Promise<PreflightReport['environment']['replicaSet']> {
  try {
    const helloResult = await db.admin().command({ hello: 1 });
    const setName = typeof helloResult.setName === 'string' ? helloResult.setName : null;
    const sessionsAvailable = typeof helloResult.logicalSessionTimeoutMinutes === 'number';
    const writablePrimary =
      helloResult.isWritablePrimary === true || helloResult.ismaster === true;
    return {
      isReplicaSet: Boolean(setName),
      setName,
      sessionsAvailable,
      writablePrimary,
      transactionsAvailable: Boolean(setName) && sessionsAvailable && writablePrimary,
    };
  } catch {
    return {
      isReplicaSet: false,
      setName: null,
      sessionsAvailable: false,
      writablePrimary: false,
      transactionsAvailable: false,
    };
  }
}

async function safeListIndexes(coll: MinimalCollection): Promise<ExistingIndexInfo[]> {
  try {
    return await coll.listIndexes().toArray();
  } catch (error) {
    const mongoError = error as { code?: number; codeName?: string };
    if (mongoError.code === 26 || mongoError.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

export async function collectCollectionStatus(
  db: MinimalDb,
  collectionName: string,
): Promise<CollectionStatus> {
  const cursor = db.listCollections({ name: collectionName });
  const found = await cursor.toArray();
  if (found.length === 0) {
    return { exists: false, documentCount: null, existingIndexes: [] };
  }
  const coll = db.collection(collectionName);
  const [indexes, count] = [await safeListIndexes(coll), await coll.countDocuments()];
  return { exists: true, documentCount: count, existingIndexes: indexes };
}

/**
 * Compte les groupes de documents qui violeraient la contrainte unique
 * (avec application du partialFilterExpression si présent).
 * Retourne 0 si l'index n'est pas unique ou si la collection n'existe pas.
 */
export async function countBlockingDuplicates(
  db: MinimalDb,
  spec: IndexSpec,
  status: CollectionStatus,
): Promise<number> {
  if (!spec.options.unique || !status.exists) return 0;
  const coll = db.collection(spec.collection);
  const pipeline: Record<string, unknown>[] = [];
  if (spec.options.partialFilterExpression) {
    pipeline.push({ $match: spec.options.partialFilterExpression });
  }
  const groupId: Record<string, string> = {};
  for (const key of Object.keys(spec.keys)) {
    groupId[key] = `$${key}`;
  }
  pipeline.push({ $group: { _id: groupId, count: { $sum: 1 } } });
  pipeline.push({ $match: { count: { $gt: 1 } } });
  pipeline.push({ $count: 'conflictingGroups' });

  const rows = (await coll.aggregate(pipeline).toArray()) as { conflictingGroups?: number }[];
  return rows[0]?.conflictingGroups ?? 0;
}

/**
 * Détermine si un index existant correspond à la spec cible.
 * Deux indexes correspondent si mêmes clés + options critiques identiques.
 */
export function isMatchingSpec(existing: ExistingIndexInfo, spec: IndexSpec): boolean {
  const existingKeys = existing.key ?? existing.keys ?? {};
  const sameKeys =
    JSON.stringify(existingKeys) === JSON.stringify(spec.keys);
  const sameUnique = Boolean(existing.unique) === Boolean(spec.options.unique);
  const sameSparse = Boolean(existing.sparse) === Boolean(spec.options.sparse);
  const sameTtl = existing.expireAfterSeconds === spec.options.expireAfterSeconds;
  const samePartial =
    JSON.stringify(existing.partialFilterExpression ?? null) ===
    JSON.stringify(spec.options.partialFilterExpression ?? null);
  return sameKeys && sameUnique && sameSparse && sameTtl && samePartial;
}

const INVALID_DOCUMENT_RULES: readonly {
  collection: string;
  filter: Record<string, unknown>;
  rule: string;
}[] = [
  {
    collection: 'event_registrations',
    filter: {
      $or: [
        { $expr: { $ne: [{ $type: '$eventId' }, 'objectId'] } },
        { $expr: { $ne: [{ $type: '$participantId' }, 'objectId'] } },
        { status: { $nin: ['active', 'cancelled'] } },
      ],
    },
    rule: 'eventId/participantId ObjectId et status active|cancelled',
  },
  {
    collection: 'idempotent_operations',
    filter: {
      $or: [
        { $expr: { $ne: [{ $type: '$scope' }, 'string'] } },
        { $expr: { $ne: [{ $type: '$actorId' }, 'string'] } },
        { $expr: { $ne: [{ $type: '$keyHash' }, 'string'] } },
        { $expr: { $ne: [{ $type: '$fingerprint' }, 'string'] } },
        { $expr: { $ne: [{ $type: '$ownerToken' }, 'string'] } },
        { status: { $nin: ['PROCESSING', 'SUCCEEDED', 'FAILED'] } },
      ],
    },
    rule: 'identifiants techniques string et status PROCESSING|SUCCEEDED|FAILED',
  },
  {
    collection: 'stripe_payment_finalizations',
    filter: {
      $or: [
        { $expr: { $ne: [{ $type: '$stripePaymentIntentId' }, 'string'] } },
        { stripePaymentIntentId: '' },
        { status: { $nin: ['PROCESSING', 'SUCCEEDED'] } },
      ],
    },
    rule: 'stripePaymentIntentId string non vide et status PROCESSING|SUCCEEDED',
  },
] as const;

export async function collectInvalidDocuments(
  db: MinimalDb,
  collections: Record<string, CollectionStatus>,
): Promise<InvalidDocumentReport[]> {
  const reports: InvalidDocumentReport[] = [];
  for (const check of INVALID_DOCUMENT_RULES) {
    const status = collections[check.collection];
    if (!status?.exists) continue;
    const invalidDocuments = await db.collection(check.collection).countDocuments(check.filter);
    if (invalidDocuments > 0) {
      reports.push({
        collection: check.collection,
        invalidDocuments,
        rule: check.rule,
      });
    }
  }
  return reports;
}

export async function runPreflight(
  db: MinimalDb,
  elintysEnv: string,
  indexes: readonly IndexSpec[],
): Promise<PreflightReport> {
  const replicaSet = await detectReplicaSet(db);
  const collectionsMap: Record<string, CollectionStatus> = {};
  const uniqueCollections = Array.from(new Set(indexes.map((i) => i.collection)));
  for (const collectionName of uniqueCollections) {
    collectionsMap[collectionName] = await collectCollectionStatus(db, collectionName);
  }

  const indexPlan: PreflightReport['indexPlan'] = [];
  const blockingDuplicates: BlockingDuplicateReport[] = [];
  const invalidDocuments = await collectInvalidDocuments(db, collectionsMap);

  for (const spec of indexes) {
    const status = collectionsMap[spec.collection];
    const existing = status.existingIndexes.find((i) => i.name === spec.name);
    if (existing) {
      if (isMatchingSpec(existing, spec)) {
        indexPlan.push({ name: spec.name, collection: spec.collection, action: 'already-present' });
      } else {
        indexPlan.push({
          name: spec.name,
          collection: spec.collection,
          action: 'conflict',
          conflictReason: 'nom existant avec spec divergente — intervention manuelle requise',
        });
      }
    } else {
      indexPlan.push({ name: spec.name, collection: spec.collection, action: 'create' });
    }

    const duplicates = await countBlockingDuplicates(db, spec, status);
    if (duplicates > 0) {
      blockingDuplicates.push({
        indexName: spec.name,
        collection: spec.collection,
        conflictingGroups: duplicates,
      });
    }
  }

  return {
    environment: {
      elintysEnv,
      dbName: db.databaseName,
      replicaSet,
    },
    collections: collectionsMap,
    indexPlan,
    blockingDuplicates,
    invalidDocuments,
    summary: {
      totalIndexes: indexes.length,
      toCreate: indexPlan.filter((p) => p.action === 'create').length,
      alreadyPresent: indexPlan.filter((p) => p.action === 'already-present').length,
      conflicts: indexPlan.filter((p) => p.action === 'conflict').length,
      blockingDuplicates: blockingDuplicates.length,
      invalidDocuments: invalidDocuments.reduce((sum, item) => sum + item.invalidDocuments, 0),
    },
  };
}

export async function runApply(
  db: MinimalDb,
  indexes: readonly IndexSpec[],
): Promise<ApplyReport> {
  const created: string[] = [];
  const alreadyPresent: string[] = [];

  for (const spec of indexes) {
    const coll = db.collection(spec.collection);
    const existing = await safeListIndexes(coll);
    const match = existing.find((i) => i.name === spec.name);

    if (match) {
      if (!isMatchingSpec(match, spec)) {
        throw new Error(
          `APPLY_REFUSED: index '${spec.name}' existe déjà avec une spec divergente — dropIndex manuel requis`,
        );
      }
      alreadyPresent.push(spec.name);
      continue;
    }

    await coll.createIndex(spec.keys, { name: spec.name, ...spec.options });
    created.push(spec.name);
  }

  // Vérification post-apply : tous les noms ET toutes les specs doivent correspondre.
  const verificationErrors: string[] = [];
  const uniqueCollections = Array.from(new Set(indexes.map((i) => i.collection)));
  for (const collectionName of uniqueCollections) {
    const present = await safeListIndexes(db.collection(collectionName));
    for (const spec of indexes.filter((i) => i.collection === collectionName)) {
      const actual = present.find((item) => item.name === spec.name);
      if (!actual) {
        verificationErrors.push(
          `POST_VERIFY_FAILED: index '${spec.name}' absent de '${collectionName}' après apply`,
        );
      } else if (!isMatchingSpec(actual, spec)) {
        verificationErrors.push(
          `POST_VERIFY_FAILED: index '${spec.name}' divergent dans '${collectionName}' après apply`,
        );
      }
    }
  }

  return {
    created,
    alreadyPresent,
    verificationPassed: verificationErrors.length === 0,
    verificationErrors,
  };
}

export async function runRollback(
  db: MinimalDb,
  indexes: readonly IndexSpec[],
): Promise<RollbackReport> {
  const dropped: string[] = [];
  const notPresent: string[] = [];
  const errors: { indexName: string; error: string }[] = [];

  for (const spec of indexes) {
    const coll = db.collection(spec.collection);
    const existing = await safeListIndexes(coll);
    if (!existing.some((i) => i.name === spec.name)) {
      notPresent.push(spec.name);
      continue;
    }

    try {
      await coll.dropIndex(spec.name);
      dropped.push(spec.name);
    } catch (err) {
      errors.push({
        indexName: spec.name,
        error: err instanceof Error ? err.message : 'UNKNOWN_ERROR',
      });
    }
  }

  return { dropped, notPresent, errors };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function connectAndRun(argv: string[]): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    // Ne jamais logguer l'URI — on log seulement l'absence.
    throw new Error('MONGODB_URI absent — aucune connexion tentée');
  }

  const elintysEnv = process.env.ELINTYS_ENV;
  const mode = parseMode(argv);

  await mongoose.connect(uri);
  const db = mongoose.connection.db as unknown as Db;
  if (!db) {
    throw new Error('CONNECTION_FAILED: mongoose.connection.db indisponible');
  }

  try {
    assertEnvironmentGuards(elintysEnv, db.databaseName);

    const minimalDb = db as unknown as MinimalDb;
    const preflight = await runPreflight(minimalDb, elintysEnv!, INDEXES);
    console.log('\n===== PRÉFLIGHT (read-only) =====');
    console.log(JSON.stringify(preflight, null, 2));

    if (mode === 'dry-run') {
      console.log('\n===== DRY-RUN — aucune écriture =====');
      console.log('Pour exécuter les créations : --apply');
      console.log('Pour rollback (indexes de cette migration uniquement) : --rollback');
      return;
    }

    if (preflight.summary.conflicts > 0) {
      throw new Error(
        'APPLY_REFUSED: des conflits de spec existent — voir preflight.indexPlan',
      );
    }
    if (!preflight.environment.replicaSet.transactionsAvailable) {
      throw new Error(
        'MIGRATION_REFUSED: transactions MongoDB indisponibles (replica set + sessions + primary writable requis)',
      );
    }
    if (preflight.summary.invalidDocuments > 0) {
      throw new Error(
        'MIGRATION_REFUSED: documents invalides détectés — aucune correction automatique autorisée',
      );
    }
    if (mode === 'apply' && preflight.summary.blockingDuplicates > 0) {
      throw new Error(
        'APPLY_REFUSED: des doublons bloqueraient un index unique — voir preflight.blockingDuplicates',
      );
    }

    if (mode === 'apply') {
      const report = await runApply(minimalDb, INDEXES);
      console.log('\n===== APPLY =====');
      console.log(JSON.stringify(report, null, 2));
      if (!report.verificationPassed) {
        throw new Error('APPLY_FAILED: vérification post-apply échouée');
      }
      return;
    }

    if (mode === 'rollback') {
      const report = await runRollback(minimalDb, INDEXES);
      console.log('\n===== ROLLBACK =====');
      console.log(JSON.stringify(report, null, 2));
      return;
    }
  } finally {
    await mongoose.disconnect();
  }
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  connectAndRun(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
