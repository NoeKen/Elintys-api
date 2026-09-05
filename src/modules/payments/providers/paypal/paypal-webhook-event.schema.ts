import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PayPalWebhookEventDocument = HydratedDocument<PayPalWebhookEvent>;

export enum PayPalWebhookEventStatus {
  /** Reçu, authentifié, traitement en cours. */
  RECEIVED = 'RECEIVED',
  /** Traité : l'effet métier a été appliqué (ou était déjà appliqué). */
  PROCESSED = 'PROCESSED',
  /** Authentifié mais hors périmètre : aucun effet métier attendu. */
  IGNORED = 'IGNORED',
  /** Traitement échoué : PayPal rejouera, la reprise est autorisée. */
  FAILED = 'FAILED',
}

/**
 * Journal de déduplication des webhooks PayPal.
 *
 * PayPal garantit une livraison AT-LEAST-ONCE : le même événement peut arriver
 * plusieurs fois, dans le désordre, ou être rejoué manuellement. La garantie
 * « un seul effet métier » vient de la conjonction :
 *
 *     index unique sur `eventId`  (ce document)
 *   + transitions conditionnelles du TicketOrder
 *   + index unique sur la référence de règlement
 *
 * Ce document n'est PAS l'autorité métier : il déduplique le TRANSPORT.
 * L'autorité reste le TicketOrder et l'état lu chez PayPal.
 *
 * autoIndex: false — index créés par migration contrôlée uniquement.
 */
@Schema({ timestamps: true, collection: 'paypal_webhook_events', autoIndex: false })
export class PayPalWebhookEvent {
  /** Identifiant d'ÉVÉNEMENT PayPal (WH-…). Distinct de l'Order ID et du Capture ID. */
  @Prop({ required: true })
  eventId!: string;

  @Prop({ required: true })
  eventType!: string;

  @Prop({
    type: String,
    enum: Object.values(PayPalWebhookEventStatus),
    default: PayPalWebhookEventStatus.RECEIVED,
  })
  status!: PayPalWebhookEventStatus;

  /** Identifiant de commande PayPal, si l'événement en porte un. */
  @Prop({ type: String, default: null })
  providerOrderId!: string | null;

  /** Identifiant de capture PayPal, si l'événement en porte un. */
  @Prop({ type: String, default: null })
  providerCaptureId!: string | null;

  /** TicketOrder Elintys résolu côté serveur — jamais cru sur parole. */
  @Prop({ type: String, default: null })
  ticketOrderId!: string | null;

  /** Code stable en cas d'échec de traitement. Jamais un message PayPal brut. */
  @Prop({ type: String, default: null })
  failureCode!: string | null;

  /**
   * Fin du bail de traitement. Un événement RECEIVED n'est repris par une
   * autre instance qu'une fois ce délai dépassé : sans lui, deux livraisons
   * concurrentes du même événement seraient toutes deux traitées.
   */
  @Prop({ type: Date, default: null })
  leaseExpiresAt!: Date | null;

  /** Jeton opaque du propriétaire courant du bail, renouvelé à chaque reprise. */
  @Prop({ type: String, default: null })
  processingToken!: string | null;

  @Prop({ type: Date, default: null })
  processedAt!: Date | null;

  /** Rétention bornée du journal de déduplication. */
  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;
}

export const PayPalWebhookEventSchema = SchemaFactory.createForClass(PayPalWebhookEvent);

/**
 * Contrainte DB principale : UN événement PayPal = UNE entrée.
 * C'est elle qui rend le rejeu inoffensif, y compris multi-instance.
 */
PayPalWebhookEventSchema.index(
  { eventId: 1 },
  { unique: true, name: 'paypal_webhook_events_unique_event' },
);

/** Recherche des événements liés à une commande, pour l'observabilité. */
PayPalWebhookEventSchema.index(
  { ticketOrderId: 1, createdAt: -1 },
  { name: 'paypal_webhook_events_by_order' },
);

/** Purge des entrées expirées — le TTL ne porte aucune compensation métier. */
PayPalWebhookEventSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'paypal_webhook_events_ttl' },
);
