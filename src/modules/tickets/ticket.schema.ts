import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TicketTypeDocument = HydratedDocument<TicketType>;
export type TicketPurchaseDocument = HydratedDocument<TicketPurchase>;

export enum TicketPurchaseStatus {
  PENDING = 'pending',
  VALID = 'valid',
  USED = 'used',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

@Schema({ timestamps: true })
export class TicketType {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 100 })
  name!: string;

  @Prop({ default: 0, min: 0 })
  price!: number;

  @Prop({ required: true, min: 1 })
  quantity!: number;

  @Prop({ default: 0, min: 0 })
  sold!: number;

  /**
   * Capacité temporairement bloquée par des commandes payantes en attente
   * de paiement (cf. TicketHold).
   *
   * INVARIANT CENTRAL : `sold + reserved <= quantity` à tout instant.
   *
   * Les documents créés avant la Vague 5 n'ont pas ce champ. Toutes les
   * expressions du domaine utilisent `$ifNull: ['$reserved', 0]` : la
   * correction ne dépend donc PAS du backfill de migration.
   */
  @Prop({ default: 0, min: 0 })
  reserved!: number;

  @Prop({ default: false })
  isFree!: boolean;

  @Prop({ maxlength: 500 })
  description?: string;
}

export const TicketTypeSchema = SchemaFactory.createForClass(TicketType);
TicketTypeSchema.index({ event: 1 });

@Schema({ timestamps: true })
export class TicketPurchase {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  buyerId!: Types.ObjectId | null;

  @Prop({ trim: true, lowercase: true })
  guestEmail?: string;

  @Prop({ trim: true, maxlength: 100 })
  guestName?: string;

  @Prop({ type: Types.ObjectId, ref: 'TicketType', required: true })
  ticketType!: Types.ObjectId;

  /**
   * Commande de billetterie payante à l'origine de cette admission (Vague 5).
   * `null` pour les billets gratuits et pour le chemin Stripe historique.
   */
  @Prop({ type: Types.ObjectId, ref: 'TicketOrder', default: null })
  order?: Types.ObjectId | null;

  @Prop({ required: true, min: 0 })
  price!: number;

  @Prop({ unique: true, sparse: true })
  qrCode?: string;

  @Prop({ enum: Object.values(TicketPurchaseStatus), default: TicketPurchaseStatus.PENDING })
  status!: TicketPurchaseStatus;

  @Prop()
  stripePaymentIntentId?: string;

  @Prop()
  scannedAt?: Date;

  /** Traçabilité : quel compte a validé ce billet à l'entrée. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  scannedBy?: Types.ObjectId | null;
}

export const TicketPurchaseSchema = SchemaFactory.createForClass(TicketPurchase);
TicketPurchaseSchema.index({ event: 1 });
TicketPurchaseSchema.index({ buyerId: 1 });
TicketPurchaseSchema.index({ guestEmail: 1 });
TicketPurchaseSchema.index({ order: 1 }, { name: 'ticket_purchases_by_order', sparse: true });
