import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import Stripe from 'stripe';
import { TicketType, TicketTypeDocument, TicketPurchase, TicketPurchaseDocument, TicketPurchaseStatus } from '../tickets/ticket.schema';
import { TicketsService } from '../tickets/tickets.service';
import { EmailsService } from '../emails/emails.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { Event, EventDocument } from '../events/event.schema';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EventAccessService } from '../events/event-access.service';
import { canPurchaseTicket, normalizeLegacyEventAccess } from '../events/event-access.policy';
import { TransactionService } from '../../shared/consistency/transactions/transaction.service';
import { OperationAlreadyProcessingError } from '../../shared/consistency/errors/consistency.errors';
import { CriticalOperationLogger } from '../../shared/consistency/observability/critical-operation.logger';
import {
  StripePaymentFinalization,
  StripePaymentFinalizationDocument,
  StripePaymentFinalizationStatus,
} from './stripe-payment-finalization.schema';

const FINALIZATION_LEASE_MS = 10 * 60 * 1000; // 10 min — supérieur au timeout webhook Stripe
const MAX_TICKETS_PER_CHECKOUT = 100;

type StripeClient = InstanceType<typeof Stripe>;

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

interface StripeCheckoutSession {
  id: string;
  payment_intent: string | { id: string } | null;
  metadata: Record<string, string> | null;
  mode?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly criticalLogger = new CriticalOperationLogger('PaymentsWebhook');
  private readonly stripe: StripeClient | null;
  private readonly webhookSecret: string | null;
  private readonly paidCheckoutEnabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly ticketsService: TicketsService,
    private readonly emailsService: EmailsService,
    private readonly eventAccessService: EventAccessService,
    private readonly transactionService: TransactionService,
    @InjectModel(TicketType.name) private readonly ticketTypeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketPurchase.name) private readonly ticketPurchaseModel: Model<TicketPurchaseDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(StripePaymentFinalization.name)
    private readonly finalizationModel: Model<StripePaymentFinalizationDocument>,
  ) {
    const stripeKey = this.configService.get<string>('stripe.secretKey');
    const webhookSec = this.configService.get<string>('stripe.webhookSecret');
    this.paidCheckoutEnabled = this.configService.get<boolean>('stripe.checkoutEnabled') === true;

    this.stripe = stripeKey
      ? new Stripe(stripeKey, { apiVersion: '2026-04-22.dahlia' })
      : null;
    this.webhookSecret = webhookSec ?? null;
  }

  private get stripeClient(): StripeClient {
    if (!this.stripe) {
      throw new ServiceUnavailableException(ErrorCodes.STRIPE_NOT_CONFIGURED);
    }
    return this.stripe;
  }

  async createCheckoutSession(
    dto: CreateCheckoutSessionDto,
    buyerId: string,
    accessGrant?: string,
  ): Promise<{ sessionUrl: string }> {
    if (!this.paidCheckoutEnabled) {
      throw new ServiceUnavailableException(ErrorCodes.PAID_CHECKOUT_NOT_READY);
    }
    const tt = await this.ticketTypeModel
      .findById(dto.ticketTypeId)
      .lean()
      .select('name price isFree quantity sold event');

    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    if (tt.isFree) {
      throw new BadRequestException('Ce billet est gratuit. Utilisez /tickets/purchase directement.');
    }

    const event = await this.eventModel.findById(tt.event).lean().select('-accessPolicy.codeHash');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    const actor = await this.eventAccessService.buildActor(
      buyerId,
      tt.event.toString(),
      accessGrant,
    );
    const decision = canPurchaseTicket(actor, normalizeLegacyEventAccess(event));
    if (!decision.allowed) throw new ForbiddenException(decision.reason);

    const available = tt.quantity - tt.sold;
    if (available < dto.quantity) {
      throw new BadRequestException(`Seulement ${available} billet(s) disponible(s).`);
    }

    const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');

    const session = await this.stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      ...(actor.email ? { customer_email: actor.email } : {}),
      line_items: [
        {
          price_data: {
            currency: 'cad',
            product_data: { name: tt.name },
            unit_amount: tt.price,
          },
          quantity: dto.quantity,
        },
      ],
      metadata: {
        ticketTypeId: dto.ticketTypeId,
        quantity:     String(dto.quantity),
        buyerId,
        guestEmail:   actor.email ?? '',
        guestName:    '',
        unitPrice:    String(tt.price),
      },
      success_url: `${frontendUrl}/paiement/succes?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${frontendUrl}/paiement/annule`,
    });

    if (!session.url) {
      throw new BadRequestException('Impossible de créer la session de paiement.');
    }

    return { sessionUrl: session.url };
  }

  handleWebhook(rawBody: Buffer, signature: string): StripeEvent {
    if (!this.webhookSecret || !this.stripe) {
      throw new ServiceUnavailableException(ErrorCodes.STRIPE_NOT_CONFIGURED);
    }
    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      ) as unknown as StripeEvent;
    } catch {
      throw new BadRequestException('Signature du webhook invalide.');
    }
  }

  async processWebhookEvent(event: StripeEvent): Promise<void> {
    if (event.type === 'checkout.session.completed') {
      await this.handleCheckoutCompleted(event.data.object as unknown as StripeCheckoutSession);
    }
  }

  async refundTicket(purchaseId: string, organizerId: string): Promise<TicketPurchase> {
    const purchase = await this.ticketPurchaseModel
      .findById(purchaseId)
      .lean()
      .select('event status stripePaymentIntentId price');
    if (!purchase) throw new NotFoundException(ErrorCodes.TICKET_NOT_FOUND);

    const event = await this.eventModel.findById(purchase.event).lean().select('organizer');
    if (!event || event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }

    if (purchase.status === TicketPurchaseStatus.REFUNDED) {
      throw new BadRequestException(ErrorCodes.INVALID_STATUS_TRANSITION);
    }
    if (purchase.status !== TicketPurchaseStatus.VALID) {
      throw new BadRequestException(ErrorCodes.INVALID_STATUS_TRANSITION);
    }

    if (purchase.stripePaymentIntentId) {
      if (!this.stripe) {
        throw new ServiceUnavailableException(ErrorCodes.STRIPE_NOT_CONFIGURED);
      }
      await this.stripeClient.refunds.create({
        payment_intent: purchase.stripePaymentIntentId,
        amount: purchase.price,
      });
    }

    const updated = await this.ticketPurchaseModel
      .findByIdAndUpdate(purchaseId, { status: TicketPurchaseStatus.REFUNDED }, { new: true })
      .lean()
      .select('-__v');
    if (!updated) throw new NotFoundException(ErrorCodes.TICKET_NOT_FOUND);
    return updated;
  }

  /**
   * Traite `checkout.session.completed`.
   *
   * Garantie : UNE PaymentIntent = UNE finalisation métier (billets créés + email),
   * y compris sous concurrence multi-instance ET au-delà des 90 jours de rétention
   * de l'idempotence générique.
   *
   * Étapes :
   *   1. Validation stricte de metadata + cohérence prix DB (autorité = TicketType)
   *   2. Claim atomique de la finalisation (upsert PROCESSING avec ownerToken/lease)
   *   3. Transaction unique : createPurchasesFromCheckout + transition SUCCEEDED
   *   4. Email post-commit (échec non bloquant, non retriable — les billets sont créés)
   *
   * Aucun identifiant Stripe brut n'est loggué : uniquement les préfixes de hash.
   */
  private async handleCheckoutCompleted(session: StripeCheckoutSession): Promise<void> {
    const stripePaymentIntentId = this.extractPaymentIntentId(session);
    if (!stripePaymentIntentId) {
      this.logger.warn(
        `checkout.session.completed: payment_intent absent (session hash ${this.hashId(session.id)})`,
      );
      return;
    }

    const piHash = this.hashId(stripePaymentIntentId);
    const parsed = this.parseAndValidateMetadata(session.metadata, piHash);
    if (!parsed) return; // logging fait dans parseAndValidateMetadata

    const expectedTotal = parsed.unitPrice * parsed.quantity;
    if (
      session.mode !== 'payment' ||
      session.payment_status !== 'paid' ||
      session.amount_total !== expectedTotal ||
      session.currency?.toLowerCase() !== 'cad'
    ) {
      this.logger.warn(
        `checkout.session.completed: état, montant ou devise Stripe incohérent (pi hash ${piHash})`,
      );
      return;
    }

    // Autorité de vérité pour le prix / gratuité : la DB, pas la metadata client
    const tt = await this.ticketTypeModel
      .findById(parsed.ticketTypeId)
      .lean()
      .select('name price isFree event');

    if (!tt) {
      this.logger.warn(`checkout.session.completed: ticketType introuvable (pi hash ${piHash})`);
      return;
    }
    if (tt.isFree) {
      this.logger.warn(`checkout.session.completed: ticketType gratuit — routage incorrect (pi hash ${piHash})`);
      return;
    }
    if (tt.price !== parsed.unitPrice) {
      this.logger.warn(
        `checkout.session.completed: prix metadata != DB (pi hash ${piHash}) — refus`,
      );
      return;
    }

    const event = await this.eventModel.findById(tt.event).lean().select('title');

    const claim = await this.claimFinalization(stripePaymentIntentId, piHash);
    if (claim.outcome === 'replay') return;
    if (claim.outcome === 'conflict') {
      throw new OperationAlreadyProcessingError('stripe-webhook');
    }
    const { ownerToken } = claim;

    this.criticalLogger.logStarted('stripe-webhook', stripePaymentIntentId, piHash, piHash);
    const startedAt = Date.now();

    let createdPurchases: { _id: Types.ObjectId; qrCode?: string }[];
    try {
      createdPurchases = await this.transactionService.run(
        'stripe-webhook',
        async (txSession) => {
          const infos = await this.ticketsService.createPurchasesFromCheckout(
            {
              ticketTypeId: parsed.ticketTypeId,
              quantity: parsed.quantity,
              buyerId: parsed.buyerId,
              guestEmail: parsed.guestEmail,
              price: parsed.unitPrice,
              stripePaymentIntentId,
            },
            txSession,
          );

          const finalized = await this.finalizationModel.updateOne(
            {
              stripePaymentIntentId,
              ownerToken,
              status: StripePaymentFinalizationStatus.PROCESSING,
            },
            {
              $set: {
                status: StripePaymentFinalizationStatus.SUCCEEDED,
                purchaseIds: infos.map((p) => p._id),
                completedAt: new Date(),
              },
            },
            { session: txSession },
          );

          if (finalized.modifiedCount !== 1) {
            // Un autre owner a repris le lease pendant notre transaction
            throw new OperationAlreadyProcessingError('stripe-webhook');
          }

          return infos;
        },
      );
    } catch (err) {
      // La transaction a rollback : ni stock, ni billets, ni SUCCEEDED n'ont été commités.
      // On supprime le PROCESSING pour permettre à Stripe de rejouer immédiatement.
      // Si le delete échoue, le lease de 10 min autorise le re-claim.
      await this.releaseFinalizationOnError(stripePaymentIntentId, ownerToken);
      const errorCode = err instanceof Error ? err.constructor.name : 'UNKNOWN_ERROR';
      this.criticalLogger.logFailed(
        'stripe-webhook',
        stripePaymentIntentId,
        piHash,
        Date.now() - startedAt,
        errorCode,
      );
      throw err;
    }

    this.criticalLogger.logSucceeded(
      'stripe-webhook',
      stripePaymentIntentId,
      piHash,
      Date.now() - startedAt,
    );

    // Email APRÈS commit — jamais dans la transaction. Un échec n'annule pas la finalisation.
    await this.sendConfirmationEmailBestEffort({
      recipientEmail: parsed.guestEmail ?? null,
      guestName: parsed.guestName,
      ticketTypeName: tt.name,
      eventReference: event?.title ?? 'Événement',
      quantity: parsed.quantity,
      totalPrice: parsed.unitPrice * parsed.quantity,
      qrCodes: createdPurchases.map((p) => p.qrCode).filter((q): q is string => Boolean(q)),
      piHash,
    });
  }

  private extractPaymentIntentId(session: StripeCheckoutSession): string | null {
    if (typeof session.payment_intent === 'string' && session.payment_intent.length > 0) {
      return session.payment_intent;
    }
    const asObject = session.payment_intent as { id?: string } | null;
    if (asObject?.id) return asObject.id;
    return null;
  }

  private parseAndValidateMetadata(
    meta: Record<string, string> | null,
    piHash: string,
  ): {
    ticketTypeId: string;
    quantity: number;
    unitPrice: number;
    buyerId: string | null;
    guestEmail?: string;
    guestName?: string;
  } | null {
    if (!meta?.ticketTypeId || !meta.quantity || !meta.unitPrice) {
      this.logger.warn(`checkout.session.completed: metadata incomplète (pi hash ${piHash})`);
      return null;
    }
    if (!Types.ObjectId.isValid(meta.ticketTypeId)) {
      this.logger.warn(`checkout.session.completed: ticketTypeId non-ObjectId (pi hash ${piHash})`);
      return null;
    }
    if (!/^[0-9]+$/.test(meta.quantity) || !/^[0-9]+$/.test(meta.unitPrice)) {
      this.logger.warn(`checkout.session.completed: metadata numérique invalide (pi hash ${piHash})`);
      return null;
    }
    const quantity = Number(meta.quantity);
    const unitPrice = Number(meta.unitPrice);
    if (
      !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_CHECKOUT ||
      !Number.isInteger(unitPrice) || unitPrice < 0
    ) {
      this.logger.warn(`checkout.session.completed: metadata numérique invalide (pi hash ${piHash})`);
      return null;
    }
    const buyerId = meta.buyerId?.trim() || null;
    if (buyerId && !Types.ObjectId.isValid(buyerId)) {
      this.logger.warn(`checkout.session.completed: buyerId non-ObjectId (pi hash ${piHash})`);
      return null;
    }
    const guestEmail = meta.guestEmail?.trim() || undefined;
    const guestName = meta.guestName?.trim() || undefined;
    if (!buyerId && !guestEmail) {
      this.logger.warn(`checkout.session.completed: ni buyerId ni guestEmail (pi hash ${piHash})`);
      return null;
    }
    return { ticketTypeId: meta.ticketTypeId, quantity, unitPrice, buyerId, guestEmail, guestName };
  }

  /**
   * Claim atomique via upsert. Retourne :
   *  - `owned`    : nous détenons le lease, procéder à la finalisation
   *  - `replay`   : déjà SUCCEEDED, aucune action
   *  - `conflict` : une autre instance a un lease actif
   */
  private async claimFinalization(
    stripePaymentIntentId: string,
    piHash: string,
  ): Promise<
    | { outcome: 'owned'; ownerToken: string }
    | { outcome: 'replay' }
    | { outcome: 'conflict' }
  > {
    const ownerToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + FINALIZATION_LEASE_MS);

    let observed: Pick<StripePaymentFinalization, 'status' | 'ownerToken'> | null;
    try {
      observed = await this.finalizationModel.findOneAndUpdate(
        { stripePaymentIntentId },
        {
          $setOnInsert: {
            status: StripePaymentFinalizationStatus.PROCESSING,
            ownerToken,
            lockedAt: now,
            leaseExpiresAt,
            purchaseIds: [],
            completedAt: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error: unknown) {
      if ((error as { code?: number } | null)?.code !== 11000) throw error;

      // Deux instances peuvent observer l'absence simultanément. L'index unique
      // choisit le gagnant ; le perdant relit l'état durable au lieu de
      // laisser fuiter une erreur MongoDB technique à Stripe.
      observed = await this.finalizationModel
        .findOne({ stripePaymentIntentId })
        .lean();
      if (!observed) throw error;
    }

    if (!observed) {
      throw new OperationAlreadyProcessingError('stripe-webhook');
    }

    if (observed.status === StripePaymentFinalizationStatus.SUCCEEDED) {
      this.criticalLogger.logReplay('stripe-webhook', stripePaymentIntentId, piHash);
      return { outcome: 'replay' };
    }

    if (observed.ownerToken === ownerToken) {
      return { outcome: 'owned', ownerToken };
    }

    // Le doc existe déjà en PROCESSING — tenter re-claim si lease expiré
    const reclaimed = await this.finalizationModel.findOneAndUpdate(
      {
        stripePaymentIntentId,
        status: StripePaymentFinalizationStatus.PROCESSING,
        leaseExpiresAt: { $lte: now },
      },
      { $set: { ownerToken, lockedAt: now, leaseExpiresAt } },
      { new: true },
    ).lean();

    if (reclaimed) {
      this.criticalLogger.logRetry('stripe-webhook', stripePaymentIntentId, piHash);
      return { outcome: 'owned', ownerToken };
    }

    this.criticalLogger.logConflict('stripe-webhook', stripePaymentIntentId, piHash, 'already_processing');
    return { outcome: 'conflict' };
  }

  private async releaseFinalizationOnError(
    stripePaymentIntentId: string,
    ownerToken: string,
  ): Promise<void> {
    try {
      await this.finalizationModel.deleteOne({
        stripePaymentIntentId,
        ownerToken,
        status: StripePaymentFinalizationStatus.PROCESSING,
      });
    } catch (err) {
      // Best-effort : si delete échoue, le lease de 10 min prendra le relais.
      this.logger.error(
        `Nettoyage finalization PROCESSING échoué (pi hash ${this.hashId(stripePaymentIntentId)}): ${String(err)}`,
      );
    }
  }

  private async sendConfirmationEmailBestEffort(args: {
    recipientEmail: string | null;
    guestName?: string;
    ticketTypeName: string;
    eventReference: string;
    quantity: number;
    totalPrice: number;
    qrCodes: string[];
    piHash: string;
  }): Promise<void> {
    if (!args.recipientEmail) return;
    try {
      await this.emailsService.sendTicketConfirmation(args.recipientEmail, {
        fullName: args.guestName || args.recipientEmail,
        eventTitle: args.eventReference,
        ticketTypeName: args.ticketTypeName,
        quantity: args.quantity,
        totalPrice: args.totalPrice,
        qrCodes: args.qrCodes,
      });
    } catch (emailErr) {
      // Les billets sont finalisés. Un échec email ne doit ni rollback,
      // ni déclencher une re-finalisation. On log et on continue.
      this.logger.error(
        `Email de confirmation échoué (pi hash ${args.piHash}): ${String(emailErr)}`,
      );
    }
  }

  private hashId(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }
}
