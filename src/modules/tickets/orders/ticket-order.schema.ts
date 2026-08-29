import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ProviderPaymentStatus } from '../../payments/providers/payment-provider.interface';

export type TicketOrderDocument = HydratedDocument<TicketOrder>;

/**
 * États d'une commande de billetterie payante.
 *
 * Une seule transition « entrante » existe par état terminal, et aucun état
 * terminal ne revient jamais vers PENDING_PAYMENT (cf. ticket-order.state-machine.ts).
 */
export enum TicketOrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

@Schema({ _id: false })
export class TicketOrderLine {
  @Prop({ type: Types.ObjectId, ref: 'TicketType', required: true })
  ticketTypeId!: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  quantity!: number;

  /** Prix unitaire figé à la création — l'autorité reste le TicketType au moment T. */
  @Prop({ required: true, min: 1 })
  unitPrice!: number;

  @Prop({ required: true, min: 1 })
  lineTotal!: number;
}

export const TicketOrderLineSchema = SchemaFactory.createForClass(TicketOrderLine);

@Schema({ _id: false })
export class TicketOrderPayment {
  /** Nom du fournisseur ayant créé le paiement ('test' | 'stripe'). */
  @Prop({ required: true })
  provider!: string;

  /** Référence opaque du fournisseur. Jamais fournie par le client. */
  @Prop({ type: String, default: null })
  reference!: string | null;

  @Prop({
    type: String,
    enum: Object.values(ProviderPaymentStatus),
    default: ProviderPaymentStatus.PENDING,
  })
  status!: ProviderPaymentStatus;

  /** URL de paiement hébergée par le fournisseur, si applicable. */
  @Prop({ type: String, default: null })
  checkoutUrl!: string | null;

  /**
   * Référence de RÈGLEMENT du fournisseur (capture PayPal, charge…), distincte
   * de `reference` qui identifie la commande côté fournisseur.
   *
   * Contrainte d'unicité en base : un même règlement ne peut jamais finaliser
   * deux TicketOrder (cf. index `ticket_orders_unique_settlement_reference`).
   */
  @Prop({ type: String, default: null })
  settlementReference!: string | null;

  @Prop({ type: Date, default: null })
  lastSyncedAt!: Date | null;
}

export const TicketOrderPaymentSchema = SchemaFactory.createForClass(TicketOrderPayment);

/**
 * Trace d'un règlement arrivé APRÈS la fin de vie de la commande.
 *
 * Aucune admission n'est créée dans ce cas : la capacité a pu être revendue.
 * La commande est marquée `requiresManualReview` et attend une décision produit
 * (cf. docs/audits/sprint-3-wave-5-paid-ticketing-core-implementation.md).
 */
@Schema({ _id: false })
export class TicketOrderLateSettlement {
  @Prop({ type: Date, required: true })
  detectedAt!: Date;

  @Prop({ required: true })
  providerStatus!: string;

  @Prop({ required: true })
  orderStatusAtDetection!: string;
}

export const TicketOrderLateSettlementSchema =
  SchemaFactory.createForClass(TicketOrderLateSettlement);

/**
 * Commande de billetterie payante.
 *
 * Séparation explicite des responsabilités :
 *   TicketOrder    = la commande et son paiement
 *   TicketHold     = la réservation temporaire de capacité
 *   TicketPurchase = l'admission (billet) réellement émise
 *
 * `TicketPurchase` n'est donc PAS utilisé comme fourre-tout commande/paiement/billet.
 *
 * autoIndex: false — les index sont créés par migration contrôlée uniquement.
 */
@Schema({ timestamps: true, collection: 'ticket_orders', autoIndex: false })
export class TicketOrder {
  /** Identité serveur de l'acheteur (`user.sub`). Jamais fournie par le client. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  buyerId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ type: [TicketOrderLineSchema], required: true })
  lines!: TicketOrderLine[];

  @Prop({ required: true, default: 'cad' })
  currency!: string;

  /** Somme des lignes, en cents. */
  @Prop({ required: true, min: 1 })
  totalAmount!: number;

  @Prop({
    type: String,
    enum: Object.values(TicketOrderStatus),
    default: TicketOrderStatus.PENDING_PAYMENT,
  })
  status!: TicketOrderStatus;

  @Prop({ type: TicketOrderPaymentSchema, required: true })
  payment!: TicketOrderPayment;

  /** Fin de la réservation de capacité. Aligné sur les holds de la commande. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  paidAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: Date, default: null })
  failedAt!: Date | null;

  @Prop({ type: Date, default: null })
  expiredAt!: Date | null;

  /** Admissions émises à la finalisation. Vide tant que la commande n'est pas PAID. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'TicketPurchase' }], default: [] })
  admissionIds!: Types.ObjectId[];

  /** Code stable d'échec (jamais un message fournisseur brut). */
  @Prop({ type: String, default: null })
  failureReason!: string | null;

  @Prop({ default: false })
  requiresManualReview!: boolean;

  @Prop({ type: TicketOrderLateSettlementSchema, default: null })
  lateSettlement!: TicketOrderLateSettlement | null;

  /** SHA-256 de la clé d'idempotence de création. La clé brute n'est jamais persistée. */
  @Prop({ type: String, default: null })
  creationKeyHash!: string | null;
}

export const TicketOrderSchema = SchemaFactory.createForClass(TicketOrder);

/** Liste « mes commandes » et écran de suivi acheteur. */
TicketOrderSchema.index({ buyerId: 1, createdAt: -1 }, { name: 'ticket_orders_by_buyer' });

/** Balayage d'expiration : commandes en attente dont la date est dépassée. */
TicketOrderSchema.index({ status: 1, expiresAt: 1 }, { name: 'ticket_orders_pending_expiry' });

/** Vue organisateur par événement. */
TicketOrderSchema.index({ event: 1, status: 1 }, { name: 'ticket_orders_by_event' });

/**
 * Contrainte DB : UNE référence de paiement fournisseur = UNE commande.
 * Partiel car la référence est null entre la création de la commande et la
 * création du paiement.
 */
/**
 * Contrainte DB : UNE référence de règlement (capture) = UNE commande.
 * Empêche qu'une même capture PayPal soit imputée à deux commandes.
 */
TicketOrderSchema.index(
  { 'payment.settlementReference': 1 },
  {
    unique: true,
    name: 'ticket_orders_unique_settlement_reference',
    partialFilterExpression: { 'payment.settlementReference': { $type: 'string' } },
  },
);

TicketOrderSchema.index(
  { 'payment.reference': 1 },
  {
    unique: true,
    name: 'ticket_orders_unique_payment_reference',
    partialFilterExpression: { 'payment.reference': { $type: 'string' } },
  },
);
