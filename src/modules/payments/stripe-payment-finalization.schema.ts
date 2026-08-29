import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StripePaymentFinalizationDocument = HydratedDocument<StripePaymentFinalization>;

export enum StripePaymentFinalizationStatus {
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
}

/**
 * Finalisation durable d'une PaymentIntent Stripe.
 *
 * Invariant métier garanti par DB :
 *   UNE PaymentIntent = UNE finalisation SUCCEEDED — permanente,
 *   pas de TTL (au-delà de la rétention 90 jours de idempotent_operations).
 *
 * Pourquoi une collection dédiée plutôt que l'IdempotencyService générique :
 *   - Rétention illimitée (Stripe peut redélivrer un webhook des mois plus tard
 *     en cas d'incident opérationnel).
 *   - Anchor de dedup sur `stripePaymentIntentId` (l'index UNIQUE ne peut pas
 *     vivre sur TicketPurchase car quantity > 1 partagent le même PI).
 *
 * Concurrence multi-instance :
 *   - `findOneAndUpdate + upsert + $setOnInsert` claim atomique.
 *   - `ownerToken + leaseExpiresAt` permettent la reprise d'une instance crashée.
 *
 * autoIndex: false — l'index UNIQUE est créé par la migration explicite.
 */
@Schema({
  timestamps: true,
  collection: 'stripe_payment_finalizations',
  autoIndex: false,
})
export class StripePaymentFinalization {
  @Prop({ type: String, required: true })
  stripePaymentIntentId!: string;

  @Prop({
    type: String,
    enum: Object.values(StripePaymentFinalizationStatus),
    default: StripePaymentFinalizationStatus.PROCESSING,
  })
  status!: StripePaymentFinalizationStatus;

  /** UUID de l'instance qui a claim le PROCESSING. */
  @Prop({ type: String, required: true })
  ownerToken!: string;

  @Prop({ type: Date, required: true })
  lockedAt!: Date;

  /** Après expiration, une autre instance peut re-claim. */
  @Prop({ type: Date, required: true })
  leaseExpiresAt!: Date;

  /** IDs des TicketPurchase créés — artefact d'audit permanent. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'TicketPurchase' }], default: [] })
  purchaseIds!: Types.ObjectId[];

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;
}

export const StripePaymentFinalizationSchema =
  SchemaFactory.createForClass(StripePaymentFinalization);

/**
 * Contrainte DB principale — UN stripePaymentIntentId = UNE finalisation.
 * Créé par la migration `migrate-sprint3-wave4-indexes.ts` (autoIndex: false).
 */
StripePaymentFinalizationSchema.index(
  { stripePaymentIntentId: 1 },
  { unique: true, name: 'stripe_finalization_unique_pi' },
);
