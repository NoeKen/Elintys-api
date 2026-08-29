import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PayPalWebhookEvent,
  PayPalWebhookEventDocument,
  PayPalWebhookEventStatus,
} from './paypal-webhook-event.schema';
import { VerifiedWebhookEvent } from './paypal-webhook.verifier';
import { TicketOrdersService } from '../../../tickets/orders/ticket-orders.service';
import { CriticalOperationLogger } from '../../../../shared/consistency/observability/critical-operation.logger';

/** Rétention du journal de déduplication. */
export const WEBHOOK_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Durée du bail de traitement d'un événement.
 *
 * Tant qu'il court, une seconde livraison du MÊME événement est un doublon
 * sans effet. Passé ce délai, l'événement est réputé abandonné (instance
 * disparue en cours de traitement) et peut être repris.
 */
export const WEBHOOK_LEASE_MS = 5 * 60 * 1000;

/**
 * Événements PayPal RÉELLEMENT traités.
 *
 * Volontairement court : tout ce qui n'est pas listé est enregistré puis
 * ignoré explicitement. Pas de gestionnaire fourre-tout.
 *
 * - CHECKOUT.ORDER.APPROVED   l'acheteur a approuvé ; le serveur peut capturer.
 * - PAYMENT.CAPTURE.COMPLETED les fonds sont capturés ; finalisation métier.
 * - PAYMENT.CAPTURE.DENIED    capture refusée ; libération de la réservation.
 * - PAYMENT.CAPTURE.REFUNDED  remboursement constaté ; hors périmètre Vague 6,
 *                             la commande est signalée pour revue manuelle.
 */
export const HANDLED_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export type WebhookOutcome =
  | 'processed'
  | 'duplicate'
  | 'ignored'
  | 'order_not_found'
  | 'failed';

/**
 * Traitement des webhooks PayPal authentifiés.
 *
 * GARANTIE : livraison at-least-once + déduplication persistante + transitions
 * conditionnelles du domaine = UN SEUL effet métier. Aucun exactly-once de
 * transport n'est supposé.
 *
 * Aucune Map ni mutex mémoire : la déduplication repose sur l'index unique
 * MongoDB `paypal_webhook_events_unique_event`, donc correcte multi-instance.
 */
@Injectable()
export class PayPalWebhookService {
  private readonly logger = new CriticalOperationLogger('PayPalWebhook');

  constructor(
    @InjectModel(PayPalWebhookEvent.name)
    private readonly eventModel: Model<PayPalWebhookEventDocument>,
    private readonly ticketOrders: TicketOrdersService,
  ) {}

  async handle(event: VerifiedWebhookEvent): Promise<WebhookOutcome> {
    const identifiers = extractIdentifiers(event);

    // Déduplication AVANT tout effet : l'index unique désigne le gagnant.
    const claimed = await this.claim(event, identifiers);
    if (!claimed) {
      this.logger.logReplay('paypal-webhook', event.eventId, event.eventId);
      return 'duplicate';
    }

    if (!isHandledEventType(event.eventType)) {
      await this.close(event.eventId, PayPalWebhookEventStatus.IGNORED, null, null);
      return 'ignored';
    }

    // Corrélation serveur : la base fait autorité, jamais le payload.
    const ticketOrderId = await this.resolveTicketOrderId(identifiers);
    if (!ticketOrderId) {
      await this.close(
        event.eventId,
        PayPalWebhookEventStatus.IGNORED,
        null,
        'TICKET_ORDER_NOT_RESOLVED',
      );
      return 'order_not_found';
    }

    try {
      // La synchronisation relit l'état chez PayPal et applique la transition.
      // Le payload du webhook n'est JAMAIS traité comme une preuve de paiement.
      await this.ticketOrders.syncPaymentAsServer(ticketOrderId);
      await this.close(event.eventId, PayPalWebhookEventStatus.PROCESSED, ticketOrderId, null);
      return 'processed';
    } catch (error: unknown) {
      const failureCode = error instanceof Error ? error.constructor.name : 'UNKNOWN_ERROR';
      // FAILED et non PROCESSED : PayPal rejouera, et le rejeu pourra reprendre.
      await this.close(
        event.eventId,
        PayPalWebhookEventStatus.FAILED,
        ticketOrderId,
        failureCode,
      );
      this.logger.logFailed('paypal-webhook', event.eventId, event.eventId, 0, failureCode);
      return 'failed';
    }
  }

  /**
   * Revendique l'événement. Retourne `false` si un autre traitement l'a déjà
   * mené à terme — le rejeu est alors sans effet.
   *
   * Un événement précédemment FAILED est repris : PayPal rejoue, et l'échec
   * transitoire ne doit pas devenir définitif. Un événement encore sous bail
   * est en revanche un doublon strict : aucun second effet.
   */
  private async claim(
    event: VerifiedWebhookEvent,
    identifiers: WebhookIdentifiers,
  ): Promise<boolean> {
    try {
      await this.eventModel.create({
        eventId: event.eventId,
        eventType: event.eventType,
        status: PayPalWebhookEventStatus.RECEIVED,
        providerOrderId: identifiers.providerOrderId,
        providerCaptureId: identifiers.providerCaptureId,
        ticketOrderId: null,
        leaseExpiresAt: new Date(Date.now() + WEBHOOK_LEASE_MS),
        expiresAt: new Date(Date.now() + WEBHOOK_EVENT_RETENTION_MS),
      });
      return true;
    } catch (error: unknown) {
      if ((error as { code?: number } | null)?.code !== 11000) throw error;

      const now = new Date();
      const reclaimed = await this.eventModel.findOneAndUpdate(
        {
          eventId: event.eventId,
          $or: [
            // Échec précédent : PayPal rejoue, la reprise est légitime.
            { status: PayPalWebhookEventStatus.FAILED },
            // Traitement abandonné : le bail a expiré.
            {
              status: PayPalWebhookEventStatus.RECEIVED,
              leaseExpiresAt: { $lte: now },
            },
          ],
        },
        {
          $set: {
            status: PayPalWebhookEventStatus.RECEIVED,
            failureCode: null,
            leaseExpiresAt: new Date(now.getTime() + WEBHOOK_LEASE_MS),
          },
        },
      );
      return reclaimed !== null;
    }
  }

  private async close(
    eventId: string,
    status: PayPalWebhookEventStatus,
    ticketOrderId: string | null,
    failureCode: string | null,
  ): Promise<void> {
    await this.eventModel.updateOne(
      { eventId },
      { $set: { status, ticketOrderId, failureCode, processedAt: new Date() } },
    );
  }

  /**
   * Résout le TicketOrder à partir de la référence de commande PayPal.
   *
   * `custom_id` n'est utilisé qu'en repli, et uniquement s'il désigne une
   * commande dont la référence fournisseur correspond effectivement.
   */
  private async resolveTicketOrderId(identifiers: WebhookIdentifiers): Promise<string | null> {
    if (identifiers.providerOrderId) {
      const resolved = await this.ticketOrders.findIdByProviderReference(
        identifiers.providerOrderId,
      );
      if (resolved) return resolved;
    }
    return null;
  }
}

export function isHandledEventType(eventType: string): eventType is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface WebhookIdentifiers {
  providerOrderId: string | null;
  providerCaptureId: string | null;
  customId: string | null;
}

/**
 * Extrait les trois identifiants distincts d'un événement PayPal.
 *
 * Les formes diffèrent selon l'événement :
 * - CHECKOUT.ORDER.*    : `resource.id` EST l'Order ID.
 * - PAYMENT.CAPTURE.*   : `resource.id` est le Capture ID, et l'Order ID vit
 *                         dans `supplementary_data.related_ids.order_id`.
 *
 * Les confondre imputerait une capture à la mauvaise commande.
 */
export function extractIdentifiers(event: VerifiedWebhookEvent): WebhookIdentifiers {
  const resource = event.resource;
  const resourceId = typeof resource.id === 'string' ? resource.id : null;
  const isCaptureEvent = event.eventType.startsWith('PAYMENT.CAPTURE.');

  const supplementary = (resource.supplementary_data ?? {}) as Record<string, unknown>;
  const relatedIds = (supplementary.related_ids ?? {}) as Record<string, unknown>;
  const relatedOrderId =
    typeof relatedIds.order_id === 'string' ? relatedIds.order_id : null;

  const units = Array.isArray(resource.purchase_units)
    ? (resource.purchase_units as Record<string, unknown>[])
    : [];
  const unitCustomId = typeof units[0]?.custom_id === 'string' ? units[0].custom_id : null;
  const customId = typeof resource.custom_id === 'string' ? resource.custom_id : unitCustomId;

  return {
    providerOrderId: isCaptureEvent ? relatedOrderId : resourceId,
    providerCaptureId: isCaptureEvent ? resourceId : null,
    customId,
  };
}
