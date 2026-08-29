import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TicketHoldDocument = HydratedDocument<TicketHold>;

/**
 * Cycle de vie d'une réservation temporaire de capacité.
 *
 *   ACTIVE ──▶ CONSUMED   (commande payée : reserved → sold)
 *   ACTIVE ──▶ RELEASED   (échec ou annulation : reserved libéré)
 *   ACTIVE ──▶ EXPIRED    (délai dépassé : reserved libéré)
 *
 * Aucun retour vers ACTIVE. Les trois états terminaux sont mutuellement
 * exclusifs, ce qui garantit qu'une réservation n'est consommée qu'une fois
 * ET libérée qu'une fois.
 */
export enum TicketHoldStatus {
  ACTIVE = 'ACTIVE',
  CONSUMED = 'CONSUMED',
  EXPIRED = 'EXPIRED',
  RELEASED = 'RELEASED',
}

export const TERMINAL_HOLD_STATUSES: readonly TicketHoldStatus[] = [
  TicketHoldStatus.CONSUMED,
  TicketHoldStatus.EXPIRED,
  TicketHoldStatus.RELEASED,
] as const;

/**
 * Réservation temporaire de capacité pour une ligne de commande.
 *
 * IMPORTANT : ce document ne porte PAS de TTL MongoDB. Un TTL supprimerait le
 * document sans exécuter la compensation métier (`$inc reserved: -quantity`),
 * ce qui perdrait définitivement de la capacité. L'expiration est explicite
 * (cf. TicketOrdersService#expireOrder et #sweepExpiredOrders).
 *
 * autoIndex: false — index créés par migration contrôlée uniquement.
 */
@Schema({ timestamps: true, collection: 'ticket_holds', autoIndex: false })
export class TicketHold {
  @Prop({ type: Types.ObjectId, ref: 'TicketOrder', required: true })
  orderId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TicketType', required: true })
  ticketTypeId!: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  quantity!: number;

  @Prop({
    type: String,
    enum: Object.values(TicketHoldStatus),
    default: TicketHoldStatus.ACTIVE,
  })
  status!: TicketHoldStatus;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  consumedAt!: Date | null;

  @Prop({ type: Date, default: null })
  releasedAt!: Date | null;
}

export const TicketHoldSchema = SchemaFactory.createForClass(TicketHold);

/**
 * Contrainte DB : une commande ne peut pas détenir deux réservations sur le
 * même type de billet. Empêche toute double réservation par rejeu.
 */
TicketHoldSchema.index(
  { orderId: 1, ticketTypeId: 1 },
  { unique: true, name: 'ticket_holds_unique_order_line' },
);

/** Recherche des réservations actives expirées d'un type de billet donné. */
TicketHoldSchema.index(
  { ticketTypeId: 1, status: 1, expiresAt: 1 },
  { name: 'ticket_holds_active_by_type' },
);
