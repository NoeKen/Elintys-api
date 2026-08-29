import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type IdempotentOperationDocument = HydratedDocument<IdempotentOperation>;

export enum IdempotentOperationStatus {
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/**
 * Enregistrement persistant d'une opération idempotente.
 *
 * La garantie multi-instance repose sur l'index unique composé
 * { scope, actorId, keyHash } côté MongoDB — jamais sur un verrou process.
 */
@Schema({
  timestamps: true,
  collection: 'idempotent_operations',
  // Les indexes sont créés par la migration contrôlée, jamais implicitement au boot.
  autoIndex: false,
})
export class IdempotentOperation {
  /** Domaine métier (ex: 'ticket-purchase', 'stripe-webhook', 'event-registration') */
  @Prop({ required: true })
  scope!: string;

  /** Identité de l'acteur ou de la ressource (userId, stripePaymentIntentId…) */
  @Prop({ required: true })
  actorId!: string;

  /** SHA-256 de la clé. La clé brute n'est jamais persistée. */
  @Prop({ required: true })
  keyHash!: string;

  /** SHA-256 des paramètres métier triés — détecte la réutilisation de clé avec payload différent */
  @Prop({ required: true })
  fingerprint!: string;

  @Prop({
    type: String,
    enum: Object.values(IdempotentOperationStatus),
    default: IdempotentOperationStatus.PROCESSING,
  })
  status!: IdempotentOperationStatus;

  /** Résultat sérialisé, stocké à l'état SUCCEEDED pour les replays */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  result!: unknown;

  /** Code d'erreur (nom de la classe ou code métier) à l'état FAILED */
  @Prop({ type: String, default: null })
  errorCode!: string | null;

  /** Jeton interne du propriétaire courant du lease. Jamais exposé ni loggué. */
  @Prop({ required: true })
  ownerToken!: string;

  /** Timestamp de prise ou reprise du lease. */
  @Prop({ type: Date, default: () => new Date() })
  lockedAt!: Date;

  /** Fin du lease PROCESSING. Une autre instance peut reprendre après ce délai. */
  @Prop({ type: Date, required: true })
  leaseExpiresAt!: Date;

  /** Timestamp de fin (SUCCEEDED ou FAILED) */
  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  /** TTL des états terminaux uniquement. Absent pendant PROCESSING. */
  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;
}

export const IdempotentOperationSchema = SchemaFactory.createForClass(IdempotentOperation);

/**
 * Index unique composé : garantie principale contre la double exécution.
 * Deux instances API différentes ne peuvent pas créer deux entrées (scope, actorId, key).
 */
IdempotentOperationSchema.index(
  { scope: 1, actorId: 1, keyHash: 1 },
  { unique: true, name: 'idempotent_ops_unique' },
);

/**
 * TTL index : purge des états terminaux après leur date d'expiration.
 * Un document PROCESSING n'a pas expiresAt et n'est donc jamais supprimé par le TTL :
 * il est repris atomiquement lorsque son lease expire.
 */
IdempotentOperationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'idempotent_ops_ttl' },
);
