import {
  applyValidation,
  assertIndexMigrationPreconditions,
  IndexSpec,
  MinimalCollection,
  MinimalDb,
  rollbackValidation,
  runApply,
  runPreflight,
  runRollback,
} from './migrate-sprint3-wave4-indexes';
import { MigrationDefinition, runMigrationCli } from './lib/migration-runner';

/**
 * migrate-sprint3-wave5-indexes.ts — Paid Ticketing Core (Vague 5).
 *
 * Réutilise INTÉGRALEMENT le moteur de migration de la Vague 4
 * (`runPreflight` / `runApply` / `runRollback`, gardes d'environnement,
 * détection de doublons bloquants, vérification post-apply). Aucune
 * abstraction n'est dupliquée : seule la LISTE d'index change, plus une
 * étape de backfill additive propre à cette vague.
 *
 * Trois modes :
 *   dry-run (défaut)  — préflight read-only, aucune écriture.
 *   --apply           — création idempotente des index + backfill additif.
 *   --rollback        — suppression UNIQUEMENT des index listés ici.
 *
 * Gardes : contrat partagé `--environment=<dev|uat|prod>` (lib/environment-guard.ts),
 * backup automatique avant écriture (`--backup-path`). Production bloquée sauf
 * confirmations explicites complètes.
 *
 * BACKFILL — `tickettypes.reserved = 0`
 * -------------------------------------
 * Additif et non destructif : n'écrit QUE sur les documents où le champ est
 * absent, et n'écrase jamais une valeur existante. La correction du domaine
 * ne dépend PAS de ce backfill : toutes les expressions utilisent
 * `$ifNull: ['$reserved', 0]`. Le backfill sert la lisibilité et les
 * agrégations de reporting.
 *
 * Rollback du backfill : volontairement ABSENT. Retirer un champ `reserved`
 * serait une opération destructive ; elle n'est donc pas automatisée.
 */

export const WAVE5_INDEXES: readonly IndexSpec[] = [
  {
    collection: 'ticket_orders',
    name: 'ticket_orders_by_buyer',
    keys: { buyerId: 1, createdAt: -1 },
    options: {},
    description: 'Listing « mes commandes » trié du plus récent au plus ancien',
  },
  {
    collection: 'ticket_orders',
    name: 'ticket_orders_pending_expiry',
    keys: { status: 1, expiresAt: 1 },
    options: {},
    description: "Balayage des commandes en attente dont la réservation est périmée",
  },
  {
    collection: 'ticket_orders',
    name: 'ticket_orders_by_event',
    keys: { event: 1, status: 1 },
    options: {},
    description: 'Vue organisateur des commandes par événement',
  },
  {
    collection: 'ticket_orders',
    name: 'ticket_orders_unique_payment_reference',
    keys: { 'payment.reference': 1 },
    options: {
      unique: true,
      partialFilterExpression: { 'payment.reference': { $type: 'string' } },
    },
    description: 'Contrainte : UNE référence de paiement fournisseur = UNE commande',
  },
  {
    collection: 'ticket_holds',
    name: 'ticket_holds_unique_order_line',
    keys: { orderId: 1, ticketTypeId: 1 },
    options: { unique: true },
    description: 'Contrainte : une commande ne réserve qu\'une fois le même type de billet',
  },
  {
    collection: 'ticket_holds',
    name: 'ticket_holds_active_by_type',
    keys: { ticketTypeId: 1, status: 1, expiresAt: 1 },
    options: {},
    description: 'Recherche des réservations actives périmées par type de billet',
  },
  {
    collection: 'ticketpurchases',
    name: 'ticket_purchases_by_order',
    keys: { order: 1 },
    options: { sparse: true },
    description: 'Rattachement des admissions à leur commande',
  },
] as const;

/** Collection MongoDB minimale + `updateMany`, nécessaire au backfill. */
export type MinimalCollectionWithUpdate = MinimalCollection & {
  updateMany: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ modifiedCount?: number }>;
};

export type MinimalDbWithUpdate = Omit<MinimalDb, 'collection'> & {
  collection: (name: string) => MinimalCollectionWithUpdate;
};

export const RESERVED_BACKFILL = {
  collection: 'tickettypes',
  field: 'reserved',
  /** Uniquement les documents où le champ est ABSENT — jamais d'écrasement. */
  filter: { reserved: { $exists: false } } as Record<string, unknown>,
  update: { $set: { reserved: 0 } } as Record<string, unknown>,
} as const;

export interface BackfillReport {
  collection: string;
  field: string;
  documentsMissingField: number;
  modified: number | null;
}

export async function countBackfillCandidates(
  db: MinimalDbWithUpdate,
): Promise<number> {
  const exists = await db
    .listCollections({ name: RESERVED_BACKFILL.collection })
    .toArray();
  if (exists.length === 0) return 0;
  return db.collection(RESERVED_BACKFILL.collection).countDocuments(RESERVED_BACKFILL.filter);
}

export async function runReservedBackfill(
  db: MinimalDbWithUpdate,
): Promise<BackfillReport> {
  const documentsMissingField = await countBackfillCandidates(db);
  if (documentsMissingField === 0) {
    return {
      collection: RESERVED_BACKFILL.collection,
      field: RESERVED_BACKFILL.field,
      documentsMissingField: 0,
      modified: 0,
    };
  }
  const result = await db
    .collection(RESERVED_BACKFILL.collection)
    .updateMany(RESERVED_BACKFILL.filter, RESERVED_BACKFILL.update);
  return {
    collection: RESERVED_BACKFILL.collection,
    field: RESERVED_BACKFILL.field,
    documentsMissingField,
    modified: result.modifiedCount ?? null,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export const wave5Migration: MigrationDefinition = {
  name: 'sprint3-wave5-indexes',
  supportsRollback: true,
  async run({ db, mode, target }) {
    const minimalDb = db as unknown as MinimalDb;
    const backfillDb = db as unknown as MinimalDbWithUpdate;
    const preflight = {
      ...(await runPreflight(minimalDb, target.environment, WAVE5_INDEXES)),
      backfillCandidates: await countBackfillCandidates(backfillDb),
    };
    if (mode === 'dry-run') return { preflight };
    assertIndexMigrationPreconditions(preflight, mode === 'apply');
    if (mode === 'apply') {
      const indexReport = await runApply(minimalDb, WAVE5_INDEXES);
      const backfillReport = await runReservedBackfill(backfillDb);
      return { preflight, changes: { indexReport, backfillReport }, postValidation: applyValidation(indexReport) };
    }
    // Le champ `reserved` n'est PAS retiré : toute suppression de champ est destructive et reste manuelle.
    const rollbackReport = await runRollback(minimalDb, WAVE5_INDEXES);
    return { preflight, changes: rollbackReport, postValidation: rollbackValidation(rollbackReport) };
  },
};

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) runMigrationCli(wave5Migration);
