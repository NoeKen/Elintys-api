import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import {
  TicketOrder,
  TicketOrderDocument,
  TicketOrderStatus,
} from './ticket-order.schema';
import { TicketHold, TicketHoldDocument, TicketHoldStatus } from './ticket-hold.schema';
import {
  assertOrderTransition,
  InvalidOrderTransitionError,
  isTerminalOrderStatus,
} from './ticket-order.state-machine';
import { TicketInventoryService } from './ticket-inventory.service';
import { CreateTicketOrderDto } from './dto/create-ticket-order.dto';
import { QueryTicketOrdersDto } from './dto/query-ticket-orders.dto';
import {
  TicketPurchase,
  TicketPurchaseDocument,
  TicketPurchaseStatus,
  TicketType,
  TicketTypeDocument,
} from '../ticket.schema';
import { Event, AdmissionMode, EventDocument, EventStatus } from '../../events/event.schema';
import { EventAccessService } from '../../events/event-access.service';
import { canPurchaseTicket, normalizeLegacyEventAccess } from '../../events/event-access.policy';
import { IdempotencyService } from '../../../shared/consistency/idempotency/idempotency.service';
import { TransactionService } from '../../../shared/consistency/transactions/transaction.service';
import { CriticalOperationLogger } from '../../../shared/consistency/observability/critical-operation.logger';
import { PaymentProviderRegistry } from '../../payments/providers/payment-provider.registry';
import {
  PaymentHandle,
  PaymentProvider,
  ProviderPaymentStatus,
} from '../../payments/providers/payment-provider.interface';
import { ErrorCodes } from '../../../shared/constants/error-codes';
import { generateQRCode } from '../../../shared/utils/qr-code';

/** Nombre maximal de commandes traitées par un balayage d'expiration. */
export const EXPIRY_SWEEP_DEFAULT_LIMIT = 100;
export const EXPIRY_SWEEP_MAX_LIMIT = 500;

export interface TicketOrderLineView {
  ticketTypeId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface TicketOrderView {
  _id: string;
  event: string;
  status: TicketOrderStatus;
  lines: TicketOrderLineView[];
  currency: string;
  totalAmount: number;
  expiresAt: string;
  payment: {
    provider: string;
    status: ProviderPaymentStatus;
    /** Jamais la référence brute du fournisseur : elle n'a aucune valeur pour le client. */
    checkoutUrl: string | null;
  };
  admissionIds: string[];
  requiresManualReview: boolean;
  failureReason: string | null;
}

export interface ExpirySweepReport {
  scanned: number;
  expired: number;
}

interface LeanOrder {
  _id: Types.ObjectId;
  buyerId: Types.ObjectId;
  event: Types.ObjectId;
  lines: {
    ticketTypeId: Types.ObjectId;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  currency: string;
  totalAmount: number;
  status: TicketOrderStatus;
  payment: {
    provider: string;
    reference: string | null;
    status: ProviderPaymentStatus;
    checkoutUrl: string | null;
    lastSyncedAt: Date | null;
  };
  expiresAt: Date;
  admissionIds: Types.ObjectId[];
  requiresManualReview: boolean;
  failureReason: string | null;
}

/**
 * Cœur transactionnel de la billetterie payante.
 *
 * Flux complet, indépendant de tout fournisseur de paiement réel :
 *
 *   sélection billet
 *      ↓  createOrder            (transaction : commande + holds + reserved)
 *   PENDING_PAYMENT
 *      ↓  syncPayment            (le SERVEUR interroge le fournisseur)
 *   PAID | FAILED | CANCELLED | EXPIRED
 *      ↓
 *   holds CONSUMED (reserved → sold + admissions) ou RELEASED/EXPIRED (reserved libéré)
 *
 * GARANTIE RÉELLEMENT OFFERTE — à ne pas confondre avec « exactly-once » :
 *
 *     livraison at-least-once (le fournisseur peut notifier N fois)
 *   + traitement idempotent   (shared/consistency)
 *   + contraintes de base     (transitions conditionnelles, index uniques)
 *   = UN SEUL effet métier
 *
 * Aucun transport exactly-once n'est promis nulle part.
 */
@Injectable()
export class TicketOrdersService {
  private readonly criticalLogger = new CriticalOperationLogger('TicketOrders');

  constructor(
    @InjectModel(TicketOrder.name)
    private readonly orderModel: Model<TicketOrderDocument>,
    @InjectModel(TicketHold.name)
    private readonly holdModel: Model<TicketHoldDocument>,
    @InjectModel(TicketType.name)
    private readonly ticketTypeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketPurchase.name)
    private readonly ticketPurchaseModel: Model<TicketPurchaseDocument>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    private readonly inventory: TicketInventoryService,
    private readonly idempotencyService: IdempotencyService,
    private readonly transactionService: TransactionService,
    private readonly eventAccessService: EventAccessService,
    private readonly providerRegistry: PaymentProviderRegistry,
    private readonly configService: ConfigService,
  ) {}

  private get holdMinutes(): number {
    return this.configService.getOrThrow<number>('ticketing.holdMinutes');
  }

  // ── Création ──────────────────────────────────────────────────────────────

  /**
   * Crée une commande payante et réserve immédiatement le stock.
   *
   * Ordre volontaire des étapes :
   *   1. sélection serveur du fournisseur (échoue vite si le paiement est fermé)
   *   2. libération paresseuse des réservations expirées des types demandés
   *   3. transaction : commande + réservations + `reserved` incrémenté
   *   4. HORS transaction : création du paiement chez le fournisseur
   *
   * L'étape 4 est un effet externe : elle ne doit jamais se trouver dans une
   * transaction MongoDB.
   */
  async createOrder(
    buyerId: string,
    dto: CreateTicketOrderDto,
    idempotencyKey: string,
    accessGrant?: string,
  ): Promise<TicketOrderView> {
    const provider = this.providerRegistry.selectForNewOrder();

    if (dto.paymentScenario && provider.name !== 'test') {
      throw new BadRequestException(ErrorCodes.TICKET_ORDER_SCENARIO_NOT_ALLOWED);
    }

    const ticketTypeIds = dto.lines.map((line) => line.ticketTypeId);
    if (new Set(ticketTypeIds).size !== ticketTypeIds.length) {
      throw new BadRequestException(ErrorCodes.TICKET_ORDER_LINE_DUPLICATE);
    }

    // Expiration paresseuse : la capacité périmée est rendue AVANT toute
    // évaluation de disponibilité, sans dépendre d'un ordonnanceur externe.
    await this.releaseExpiredForTicketTypes(ticketTypeIds);

    const orderId = await this.idempotencyService.execute<string>({
      scope: 'ticket-order-create',
      actorId: buyerId,
      idempotencyKey,
      payload: {
        lines: dto.lines
          .map((line) => `${line.ticketTypeId}:${line.quantity}`)
          .sort(),
      },
      operation: (session) =>
        this.createOrderInTransaction(buyerId, dto, provider, idempotencyKey, accessGrant, session),
      toReplayResult: (createdOrderId) => createdOrderId,
    });

    await this.ensurePaymentInitialized(orderId, provider, dto.paymentScenario);
    return this.toView(await this.requireOrder(orderId));
  }

  private async createOrderInTransaction(
    buyerId: string,
    dto: CreateTicketOrderDto,
    provider: PaymentProvider,
    idempotencyKey: string,
    accessGrant: string | undefined,
    session: ClientSession,
  ): Promise<string> {
    const ticketTypes = await this.ticketTypeModel
      .find({ _id: { $in: dto.lines.map((line) => new Types.ObjectId(line.ticketTypeId)) } })
      .session(session)
      .lean()
      .select('event price isFree quantity sold reserved');

    if (ticketTypes.length !== dto.lines.length) {
      throw new NotFoundException('Type de billet introuvable.');
    }
    if (ticketTypes.some((ticketType) => ticketType.isFree)) {
      throw new BadRequestException(ErrorCodes.TICKET_ORDER_PAID_TICKET_REQUIRED);
    }

    const eventIds = new Set(ticketTypes.map((ticketType) => ticketType.event.toString()));
    if (eventIds.size !== 1) {
      throw new BadRequestException(ErrorCodes.TICKET_ORDER_MIXED_EVENTS);
    }
    const eventId = [...eventIds][0];

    const event = await this.eventModel
      .findById(eventId)
      .session(session)
      .lean()
      .select('-accessPolicy.codeHash');
    if (!event || event.status !== EventStatus.PUBLISHED || event.archivedAt) {
      throw new NotFoundException('Événement introuvable.');
    }
    if (!(event.admissionModes ?? []).includes(AdmissionMode.PAID_TICKET)) {
      throw new BadRequestException(ErrorCodes.TICKET_ORDER_ADMISSION_NOT_AVAILABLE);
    }

    const actor = await this.eventAccessService.buildActor(buyerId, eventId, accessGrant, session);
    const decision = canPurchaseTicket(actor, normalizeLegacyEventAccess(event));
    if (!decision.allowed) throw new ForbiddenException(decision.reason);

    const priceById = new Map(
      ticketTypes.map((ticketType) => [ticketType._id.toString(), ticketType.price]),
    );
    const lines = dto.lines.map((line) => {
      const unitPrice = priceById.get(line.ticketTypeId) ?? 0;
      return {
        ticketTypeId: new Types.ObjectId(line.ticketTypeId),
        quantity: line.quantity,
        unitPrice,
        lineTotal: unitPrice * line.quantity,
      };
    });
    const totalAmount = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    if (totalAmount <= 0) {
      throw new BadRequestException(ErrorCodes.TICKET_ORDER_PAID_TICKET_REQUIRED);
    }

    const expiresAt = new Date(Date.now() + this.holdMinutes * 60_000);

    const [order] = await this.orderModel.create(
      [
        {
          buyerId: new Types.ObjectId(buyerId),
          event: new Types.ObjectId(eventId),
          lines,
          currency: 'cad',
          totalAmount,
          status: TicketOrderStatus.PENDING_PAYMENT,
          payment: {
            provider: provider.name,
            reference: null,
            status: ProviderPaymentStatus.PENDING,
            checkoutUrl: null,
            lastSyncedAt: null,
          },
          expiresAt,
          admissionIds: [],
          requiresManualReview: false,
          creationKeyHash: hashSecret(idempotencyKey),
        },
      ],
      { session },
    );

    // Séquentiel — jamais Promise.all dans une transaction MongoDB.
    for (const line of lines) {
      await this.inventory.reserve(line.ticketTypeId, line.quantity, session);
      await this.holdModel.create(
        [
          {
            orderId: order._id,
            eventId: new Types.ObjectId(eventId),
            ticketTypeId: line.ticketTypeId,
            quantity: line.quantity,
            status: TicketHoldStatus.ACTIVE,
            expiresAt,
          },
        ],
        { session },
      );
    }

    return order._id.toString();
  }

  /**
   * Crée le paiement chez le fournisseur, une seule fois par commande.
   *
   * Idempotent : la référence n'est écrite que si elle est encore `null`
   * (`payment.reference: null` dans le filtre). Un rejeu ne crée donc jamais
   * un deuxième paiement associé à la commande.
   *
   * Si le fournisseur est indisponible, la commande est libérée immédiatement :
   * on ne laisse jamais du stock réservé derrière un paiement inexistant.
   */
  private async ensurePaymentInitialized(
    orderId: string,
    provider: PaymentProvider,
    scenario: string | undefined,
  ): Promise<void> {
    const order = await this.requireOrder(orderId);
    if (order.payment.reference !== null || order.status !== TicketOrderStatus.PENDING_PAYMENT) {
      return;
    }

    let handle: PaymentHandle;
    try {
      handle = await provider.createPayment({
        orderId,
        amount: order.totalAmount,
        currency: 'cad',
        description: `Commande Elintys ${orderId}`,
        expiresAt: order.expiresAt,
        scenario,
      });
    } catch {
      await this.settleUnsuccessful(
        orderId,
        TicketOrderStatus.FAILED,
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
      );
      throw new ConflictException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE);
    }

    await this.orderModel.updateOne(
      {
        _id: new Types.ObjectId(orderId),
        status: TicketOrderStatus.PENDING_PAYMENT,
        'payment.reference': null,
      },
      {
        $set: {
          'payment.reference': handle.reference,
          'payment.status': handle.status,
          'payment.checkoutUrl': handle.checkoutUrl,
          'payment.lastSyncedAt': new Date(),
        },
      },
    );
  }

  // ── Lecture ───────────────────────────────────────────────────────────────

  async findOne(orderId: string, buyerId: string): Promise<TicketOrderView> {
    const order = await this.requireOwnedOrder(orderId, buyerId);
    return this.toView(order);
  }

  async findMine(
    buyerId: string,
    query: QueryTicketOrdersDto,
  ): Promise<{ data: TicketOrderView[]; total: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter = { buyerId: new Types.ObjectId(buyerId) };

    const [orders, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<LeanOrder[]>()
        .select('-__v -creationKeyHash -payment.reference'),
      this.orderModel.countDocuments(filter),
    ]);

    return { data: orders.map((order) => this.toView(order)), total, page, limit };
  }

  // ── Synchronisation du paiement ───────────────────────────────────────────

  /**
   * Demande au FOURNISSEUR l'issue faisant autorité et applique la transition.
   *
   * Aucun statut de paiement n'est jamais accepté depuis le client : c'est le
   * serveur qui interroge le fournisseur. Un « callback » n'est donc qu'un
   * déclencheur, jamais une source de vérité.
   */
  async syncPayment(orderId: string, buyerId: string): Promise<TicketOrderView> {
    const order = await this.requireOwnedOrder(orderId, buyerId);

    if (order.status === TicketOrderStatus.PAID) {
      return this.toView(order); // rejeu : aucun effet supplémentaire
    }
    if (order.payment.reference === null) {
      throw new ConflictException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE);
    }

    const provider = this.providerRegistry.resolveByName(order.payment.provider);
    const providerStatus = await provider.getPaymentStatus(order.payment.reference);

    if (isTerminalOrderStatus(order.status)) {
      return this.handleAfterTerminal(order, providerStatus);
    }

    // Le hold est-il déjà périmé ? L'expiration est évaluée AVANT toute
    // finalisation : une confirmation tardive ne doit jamais ressusciter
    // une capacité qui a pu être revendue.
    if (order.expiresAt.getTime() <= Date.now()) {
      await this.expireOrder(orderId);
      return this.handleAfterTerminal(await this.requireOrder(orderId), providerStatus);
    }

    switch (providerStatus) {
      case ProviderPaymentStatus.SUCCEEDED:
        await this.settleSucceeded(order);
        return this.toView(await this.requireOrder(orderId));
      case ProviderPaymentStatus.FAILED:
        await this.settleUnsuccessful(orderId, TicketOrderStatus.FAILED, 'PROVIDER_DECLINED');
        return this.toView(await this.requireOrder(orderId));
      case ProviderPaymentStatus.CANCELLED:
        await this.settleUnsuccessful(orderId, TicketOrderStatus.CANCELLED, 'PROVIDER_CANCELLED');
        return this.toView(await this.requireOrder(orderId));
      case ProviderPaymentStatus.PENDING:
        await this.orderModel.updateOne(
          { _id: order._id, status: TicketOrderStatus.PENDING_PAYMENT },
          { $set: { 'payment.lastSyncedAt': new Date() } },
        );
        return this.toView(await this.requireOrder(orderId));
    }
  }

  /**
   * Issue reçue alors que la commande n'est plus en attente.
   *
   * Un succès tardif est traité comme un incident : aucune admission, aucun
   * stock, escalade explicite. La suite (remboursement automatique, honorer la
   * commande, réémission) est une DÉCISION PRODUIT non tranchée — elle n'est
   * volontairement pas inventée ici.
   */
  private async handleAfterTerminal(
    order: LeanOrder,
    providerStatus: ProviderPaymentStatus,
  ): Promise<TicketOrderView> {
    if (providerStatus !== ProviderPaymentStatus.SUCCEEDED) {
      return this.toView(order);
    }
    if (order.status === TicketOrderStatus.PAID) {
      return this.toView(order);
    }

    await this.orderModel.updateOne(
      { _id: order._id, status: order.status, lateSettlement: null },
      {
        $set: {
          requiresManualReview: true,
          lateSettlement: {
            detectedAt: new Date(),
            providerStatus,
            orderStatusAtDetection: order.status,
          },
        },
      },
    );
    this.criticalLogger.logFailed(
      'ticket-order-late-settlement',
      order._id.toString(),
      hashSecret(order.payment.reference ?? ''),
      0,
      ErrorCodes.TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW,
    );
    throw new ConflictException(ErrorCodes.TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW);
  }

  // ── Finalisation ──────────────────────────────────────────────────────────

  /**
   * Transition PENDING_PAYMENT → PAID, atomique et idempotente.
   *
   * Dans UNE SEULE transaction :
   *   1. commande PENDING_PAYMENT → PAID (filtre conditionnel sur le statut)
   *   2. chaque hold ACTIVE → CONSUMED (exactement une modification attendue)
   *   3. `reserved -= q` et `sold += q`
   *   4. création des admissions
   *
   * Une deuxième notification de succès ne peut produire ni admission
   * supplémentaire, ni double consommation, ni double incrément : les filtres
   * conditionnels ne correspondent plus.
   */
  private async settleSucceeded(order: LeanOrder): Promise<void> {
    const orderId = order._id.toString();
    const reference = order.payment.reference ?? '';

    await this.idempotencyService.execute<string[]>({
      scope: 'ticket-order-settle',
      actorId: orderId,
      // Clé dérivée côté serveur de la référence fournisseur — jamais du client.
      idempotencyKey: `${reference}:SUCCEEDED`,
      payload: { orderId, reference },
      operation: async (session) => {
        const paid = await this.orderModel.findOneAndUpdate(
          { _id: order._id, status: TicketOrderStatus.PENDING_PAYMENT },
          {
            $set: {
              status: TicketOrderStatus.PAID,
              paidAt: new Date(),
              'payment.status': ProviderPaymentStatus.SUCCEEDED,
              'payment.lastSyncedAt': new Date(),
            },
          },
          { new: true, session },
        );

        if (!paid) {
          const current = await this.orderModel
            .findById(order._id)
            .session(session)
            .lean<LeanOrder>()
            .select('status admissionIds');
          if (current?.status === TicketOrderStatus.PAID) {
            return (current.admissionIds ?? []).map((id) => id.toString());
          }
          throw new InvalidOrderTransitionError(
            current?.status ?? TicketOrderStatus.PENDING_PAYMENT,
            TicketOrderStatus.PAID,
          );
        }
        assertOrderTransition(TicketOrderStatus.PENDING_PAYMENT, TicketOrderStatus.PAID);

        const admissionIds: Types.ObjectId[] = [];
        for (const line of order.lines) {
          const consumed = await this.holdModel.updateOne(
            {
              orderId: order._id,
              ticketTypeId: line.ticketTypeId,
              status: TicketHoldStatus.ACTIVE,
            },
            { $set: { status: TicketHoldStatus.CONSUMED, consumedAt: new Date() } },
            { session },
          );
          if (consumed.modifiedCount !== 1) {
            // Le hold a été expiré ou libéré entre-temps : la transaction
            // entière est annulée, aucun billet n'est émis.
            throw new ConflictException(ErrorCodes.TICKET_ORDER_NOT_PENDING);
          }

          await this.inventory.consumeReservation(line.ticketTypeId, line.quantity, session);

          for (let index = 0; index < line.quantity; index++) {
            const [purchase] = await this.ticketPurchaseModel.create(
              [
                {
                  event: order.event,
                  ticketType: line.ticketTypeId,
                  order: order._id,
                  buyerId: order.buyerId,
                  price: line.unitPrice,
                  qrCode: generateQRCode(line.ticketTypeId.toString()),
                  status: TicketPurchaseStatus.VALID,
                },
              ],
              { session },
            );
            admissionIds.push(purchase._id);
          }
        }

        await this.orderModel.updateOne(
          { _id: order._id, status: TicketOrderStatus.PAID },
          { $set: { admissionIds } },
          { session },
        );

        return admissionIds.map((id) => id.toString());
      },
      toReplayResult: (ids) => ids,
    });
  }

  /**
   * Transition PENDING_PAYMENT → FAILED | CANCELLED | EXPIRED avec libération
   * de la capacité EXACTEMENT UNE FOIS.
   *
   * La garantie « une seule libération » vient de la conjonction :
   *   - transition de commande conditionnelle au statut PENDING_PAYMENT
   *   - transition de hold conditionnelle au statut ACTIVE
   *   - décrément `reserved` conditionnel à `reserved >= quantity`
   * le tout dans la même transaction.
   */
  private async settleUnsuccessful(
    orderId: string,
    target: TicketOrderStatus.FAILED | TicketOrderStatus.CANCELLED | TicketOrderStatus.EXPIRED,
    reason: string,
    onlyIfExpired = false,
  ): Promise<boolean> {
    assertOrderTransition(TicketOrderStatus.PENDING_PAYMENT, target);

    const timestampField =
      target === TicketOrderStatus.FAILED
        ? 'failedAt'
        : target === TicketOrderStatus.CANCELLED
          ? 'cancelledAt'
          : 'expiredAt';
    const holdStatus =
      target === TicketOrderStatus.EXPIRED ? TicketHoldStatus.EXPIRED : TicketHoldStatus.RELEASED;

    return this.transactionService.run(`ticket-order-${target.toLowerCase()}`, async (session) => {
      const now = new Date();
      const closed = await this.orderModel.findOneAndUpdate(
        {
          _id: new Types.ObjectId(orderId),
          status: TicketOrderStatus.PENDING_PAYMENT,
          ...(onlyIfExpired ? { expiresAt: { $lte: now } } : {}),
        },
        {
          $set: {
            status: target,
            [timestampField]: now,
            failureReason: reason,
          },
        },
        { new: true, session },
      );

      // Déjà clôturée par une autre instance ou pas encore expirée : aucun effet.
      if (!closed) return false;

      const holds = await this.holdModel
        .find({ orderId: closed._id, status: TicketHoldStatus.ACTIVE })
        .session(session)
        .lean()
        .select('_id ticketTypeId quantity');

      for (const hold of holds) {
        const released = await this.holdModel.updateOne(
          { _id: hold._id, status: TicketHoldStatus.ACTIVE },
          { $set: { status: holdStatus, releasedAt: now } },
          { session },
        );
        if (released.modifiedCount !== 1) {
          throw new ConflictException(ErrorCodes.TICKET_ORDER_NOT_PENDING);
        }
        await this.inventory.releaseReservation(hold.ticketTypeId, hold.quantity, session);
      }

      return true;
    });
  }

  // ── Annulation acheteur ───────────────────────────────────────────────────

  async cancelOrder(orderId: string, buyerId: string): Promise<TicketOrderView> {
    const order = await this.requireOwnedOrder(orderId, buyerId);
    if (order.status !== TicketOrderStatus.PENDING_PAYMENT) {
      throw new ConflictException(ErrorCodes.TICKET_ORDER_NOT_PENDING);
    }

    const cancelled = await this.settleUnsuccessful(
      orderId,
      TicketOrderStatus.CANCELLED,
      'BUYER_CANCELLED',
    );

    // Effet externe best-effort, APRÈS le commit : la vérité est en base.
    if (cancelled && order.payment.reference) {
      const provider = this.providerRegistry.resolveByName(order.payment.provider);
      const startedAt = Date.now();
      try {
        await provider.cancelPayment(order.payment.reference);
      } catch {
        // Une panne fournisseur ne doit pas transformer une annulation déjà
        // commitée en erreur client. Le provider sera réconcilié séparément.
        this.criticalLogger.logFailed(
          'ticket-order-payment-cancel',
          orderId,
          hashSecret(order.payment.reference),
          Date.now() - startedAt,
          ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        );
      }
    }

    return this.toView(await this.requireOrder(orderId));
  }

  // ── Expiration ────────────────────────────────────────────────────────────

  /**
   * Expire une commande dont le délai est dépassé et restitue sa capacité.
   *
   * `onlyIfExpired` garantit qu'aucune commande encore valide ne peut être
   * expirée par erreur, même en cas d'appel concurrent.
   */
  async expireOrder(orderId: string): Promise<boolean> {
    return this.settleUnsuccessful(
      orderId,
      TicketOrderStatus.EXPIRED,
      'HOLD_EXPIRED',
      true,
    );
  }

  /**
   * Balayage explicite des commandes expirées.
   *
   * AUCUN TTL MongoDB n'est utilisé pour restituer la capacité : un TTL
   * supprimerait le document sans exécuter la compensation `reserved -= q`.
   * Chaque commande est expirée dans sa propre transaction, ce qui rend le
   * balayage interruptible et rejouable sans effet cumulatif.
   */
  async sweepExpiredOrders(limit = EXPIRY_SWEEP_DEFAULT_LIMIT): Promise<ExpirySweepReport> {
    const safeLimit = Math.min(Math.max(1, limit), EXPIRY_SWEEP_MAX_LIMIT);
    const candidates = await this.orderModel
      .find({ status: TicketOrderStatus.PENDING_PAYMENT, expiresAt: { $lte: new Date() } })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(safeLimit)
      .lean()
      .select('_id');

    let expired = 0;
    for (const candidate of candidates) {
      if (await this.expireOrder(candidate._id.toString())) expired += 1;
    }
    return { scanned: candidates.length, expired };
  }

  /**
   * Expiration paresseuse ciblée : rend la capacité périmée des types de
   * billets concernés avant d'évaluer leur disponibilité.
   *
   * C'est ce mécanisme — et non un ordonnanceur — qui garantit qu'aucune
   * capacité n'est retenue à tort. Le balayage global reste disponible pour
   * l'exploitation, mais la correction n'en dépend pas.
   */
  async releaseExpiredForTicketTypes(ticketTypeIds: string[]): Promise<number> {
    const now = new Date();
    const expiredHolds = await this.holdModel
      .find({
        ticketTypeId: { $in: ticketTypeIds.map((id) => new Types.ObjectId(id)) },
        status: TicketHoldStatus.ACTIVE,
        expiresAt: { $lte: now },
      })
      .limit(EXPIRY_SWEEP_MAX_LIMIT)
      .lean()
      .select('orderId');

    const orderIds = [...new Set(expiredHolds.map((hold) => hold.orderId.toString()))];
    let expired = 0;
    for (const orderId of orderIds) {
      if (await this.expireOrder(orderId)) expired += 1;
    }
    return expired;
  }

  // ── Utilitaires ───────────────────────────────────────────────────────────

  private async requireOrder(orderId: string): Promise<LeanOrder> {
    const order = await this.orderModel
      .findById(orderId)
      .lean<LeanOrder>()
      .select('-__v -creationKeyHash');
    if (!order) throw new NotFoundException(ErrorCodes.TICKET_ORDER_NOT_FOUND);
    return order;
  }

  private async requireOwnedOrder(orderId: string, buyerId: string): Promise<LeanOrder> {
    const order = await this.requireOrder(orderId);
    // L'identité vient de `user.sub` : le client ne fournit jamais `buyerId`.
    if (order.buyerId.toString() !== buyerId) {
      throw new NotFoundException(ErrorCodes.TICKET_ORDER_NOT_FOUND);
    }
    return order;
  }

  private toView(order: LeanOrder): TicketOrderView {
    return {
      _id: order._id.toString(),
      event: order.event.toString(),
      status: order.status,
      lines: (order.lines ?? []).map((line) => ({
        ticketTypeId: line.ticketTypeId.toString(),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
      currency: order.currency,
      totalAmount: order.totalAmount,
      expiresAt: order.expiresAt.toISOString(),
      payment: {
        provider: order.payment.provider,
        status: order.payment.status,
        checkoutUrl: order.payment.checkoutUrl ?? null,
      },
      admissionIds: (order.admissionIds ?? []).map((id) => id.toString()),
      requiresManualReview: order.requiresManualReview === true,
      failureReason: order.failureReason ?? null,
    };
  }
}

/** SHA-256 tronqué — jamais la valeur brute (clé d'idempotence, référence fournisseur). */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
