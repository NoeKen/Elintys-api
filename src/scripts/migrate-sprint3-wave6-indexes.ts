import {
  applyValidation,
  assertIndexMigrationPreconditions,
  IndexSpec,
  MinimalDb,
  rollbackValidation,
  runApply,
  runPreflight,
  runRollback,
} from './migrate-sprint3-wave4-indexes';
import { MigrationDefinition, runMigrationCli } from './lib/migration-runner';

/**
 * migrate-sprint3-wave6-indexes.ts — PayPal Sandbox (Vague 6).
 *
 * Réutilise le moteur de migration des Vagues 4 et 5 : gardes d'environnement,
 * préflight read-only, détection de doublons bloquants, vérification post-apply
 * et rollback ciblé. Seule la LISTE d'index change — aucune abstraction n'est
 * dupliquée.
 *
 * Gardes : contrat partagé `--environment=<dev|uat|prod>` (lib/environment-guard.ts),
 * backup automatique avant écriture (`--backup-path`). Production bloquée sauf
 * confirmations explicites complètes.
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

export const wave6Migration: MigrationDefinition = {
  name: 'sprint3-wave6-indexes',
  supportsRollback: true,
  async run({ db, mode, target }) {
    const minimalDb = db as unknown as MinimalDb;
    const preflight = await runPreflight(minimalDb, target.environment, WAVE6_INDEXES);
    if (mode === 'dry-run') return { preflight };
    assertIndexMigrationPreconditions(preflight, mode === 'apply');
    if (mode === 'apply') {
      const report = await runApply(minimalDb, WAVE6_INDEXES);
      return { preflight, changes: report, postValidation: applyValidation(report) };
    }
    const report = await runRollback(minimalDb, WAVE6_INDEXES);
    return { preflight, changes: report, postValidation: rollbackValidation(report) };
  },
};

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) runMigrationCli(wave6Migration);
