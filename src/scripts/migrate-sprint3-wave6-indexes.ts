import 'dotenv/config';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import {
  assertEnvironmentGuards,
  IndexSpec,
  MinimalDb,
  parseMode,
  runApply,
  runPreflight,
  runRollback,
} from './migrate-sprint3-wave4-indexes';

/**
 * migrate-sprint3-wave6-indexes.ts — PayPal Sandbox (Vague 6).
 *
 * Réutilise le moteur de migration des Vagues 4 et 5 : gardes d'environnement,
 * préflight read-only, détection de doublons bloquants, vérification post-apply
 * et rollback ciblé. Seule la LISTE d'index change — aucune abstraction n'est
 * dupliquée.
 *
 * Gardes héritées : `ELINTYS_ENV === 'dev'` ET base `elintys-dev`.
 * Production : impossible par construction.
 *
 * Aucun champ n'est transformé ni supprimé : les deux collections concernées
 * ne reçoivent que des index. `payment.settlementReference` est un champ
 * additif dont l'absence est gérée par le filtre partiel de son index.
 */
export const WAVE6_INDEXES: readonly IndexSpec[] = [
  {
    collection: 'ticket_orders',
    name: 'ticket_orders_unique_settlement_reference',
    keys: { 'payment.settlementReference': 1 },
    options: {
      unique: true,
      partialFilterExpression: { 'payment.settlementReference': { $type: 'string' } },
    },
    description:
      'Contrainte : UNE référence de règlement (capture PayPal) = UNE commande finalisée',
  },
  {
    collection: 'paypal_webhook_events',
    name: 'paypal_webhook_events_unique_event',
    keys: { eventId: 1 },
    options: { unique: true },
    description: 'Déduplication du transport : UN événement PayPal = UNE entrée',
  },
  {
    collection: 'paypal_webhook_events',
    name: 'paypal_webhook_events_by_order',
    keys: { ticketOrderId: 1, createdAt: -1 },
    options: {},
    description: "Observabilité : événements d'une commande, du plus récent au plus ancien",
  },
  {
    collection: 'paypal_webhook_events',
    name: 'paypal_webhook_events_ttl',
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    description:
      'Rétention bornée du journal de déduplication (aucune compensation métier portée par ce TTL)',
  },
] as const;

async function connectAndRun(argv: string[]): Promise<void> {
  const uri = process.env.MONGODB_URI;
  // L'URI n'est jamais lue ni logguée en clair : on ne signale que son absence.
  if (!uri) throw new Error('MONGODB_URI absent — aucune connexion tentée');

  const elintysEnv = process.env.ELINTYS_ENV;
  const mode = parseMode(argv);

  await mongoose.connect(uri);
  const db = mongoose.connection.db as unknown as Db;
  if (!db) throw new Error('CONNECTION_FAILED: mongoose.connection.db indisponible');

  try {
    assertEnvironmentGuards(elintysEnv, db.databaseName);
    const minimalDb = db as unknown as MinimalDb;

    const preflight = await runPreflight(minimalDb, elintysEnv as string, WAVE6_INDEXES);
    console.log('\n===== PRÉFLIGHT VAGUE 6 (read-only) =====');
    console.log(JSON.stringify(preflight, null, 2));

    if (mode === 'dry-run') {
      console.log('\n===== DRY-RUN — aucune écriture =====');
      console.log('Pour appliquer : --apply');
      console.log('Pour supprimer les index de cette vague : --rollback');
      return;
    }

    if (preflight.summary.conflicts > 0) {
      throw new Error('APPLY_REFUSED: conflits de spec — voir preflight.indexPlan');
    }
    if (!preflight.environment.replicaSet.transactionsAvailable) {
      throw new Error('MIGRATION_REFUSED: transactions MongoDB indisponibles');
    }
    if (preflight.summary.invalidDocuments > 0) {
      throw new Error('MIGRATION_REFUSED: documents invalides détectés');
    }

    if (mode === 'apply') {
      if (preflight.summary.blockingDuplicates > 0) {
        throw new Error('APPLY_REFUSED: doublons bloquant un index unique');
      }
      const report = await runApply(minimalDb, WAVE6_INDEXES);
      console.log('\n===== APPLY VAGUE 6 =====');
      console.log(JSON.stringify(report, null, 2));
      if (!report.verificationPassed) {
        throw new Error('APPLY_FAILED: vérification post-apply échouée');
      }
      return;
    }

    const rollback = await runRollback(minimalDb, WAVE6_INDEXES);
    console.log('\n===== ROLLBACK VAGUE 6 (index uniquement) =====');
    console.log(JSON.stringify(rollback, null, 2));
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
