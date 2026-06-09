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
import Stripe from 'stripe';
import { TicketType, TicketTypeDocument, TicketPurchase, TicketPurchaseDocument, TicketPurchaseStatus } from '../tickets/ticket.schema';
import { TicketsService } from '../tickets/tickets.service';
import { EmailsService } from '../emails/emails.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { Event, EventDocument } from '../events/event.schema';
import { ErrorCodes } from '../../shared/constants/error-codes';

type StripeClient = InstanceType<typeof Stripe>;

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

interface StripeCheckoutSession {
  id: string;
  payment_intent: string | { id: string } | null;
  metadata: Record<string, string> | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly stripe: StripeClient | null;
  private readonly webhookSecret: string | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly ticketsService: TicketsService,
    private readonly emailsService: EmailsService,
    @InjectModel(TicketType.name) private readonly ticketTypeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketPurchase.name) private readonly ticketPurchaseModel: Model<TicketPurchaseDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
  ) {
    const stripeKey = this.configService.get<string>('stripe.secretKey');
    const webhookSec = this.configService.get<string>('stripe.webhookSecret');

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
    buyerId: string | null,
  ): Promise<{ sessionUrl: string }> {
    const tt = await this.ticketTypeModel
      .findById(dto.ticketTypeId)
      .lean()
      .select('name price isFree quantity sold event');

    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    if (tt.isFree) {
      throw new BadRequestException('Ce billet est gratuit. Utilisez /tickets/purchase directement.');
    }

    const available = tt.quantity - tt.sold;
    if (available < dto.quantity) {
      throw new BadRequestException(`Seulement ${available} billet(s) disponible(s).`);
    }

    const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');

    const session = await this.stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
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
        buyerId:      buyerId ?? '',
        guestEmail:   dto.guestEmail ?? '',
        guestName:    dto.guestName ?? '',
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

    if (purchase.stripePaymentIntentId && this.stripe) {
      await this.stripeClient.refunds.create({
        payment_intent: purchase.stripePaymentIntentId,
        amount: purchase.price,
      });
    }

    const updated = await this.ticketPurchaseModel
      .findByIdAndUpdate(purchaseId, { status: TicketPurchaseStatus.REFUNDED }, { new: true })
      .lean()
      .select('-__v');
    return updated!;
  }

  private async handleCheckoutCompleted(session: StripeCheckoutSession): Promise<void> {
    const meta = session.metadata;
    if (!meta?.ticketTypeId || !meta.quantity) {
      this.logger.warn(`Webhook checkout.session.completed sans métadonnées : ${session.id}`);
      return;
    }

    // Idempotence : vérifier que ce paiement n'a pas déjà été traité
    const stripePaymentIntentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent as { id: string } | null)?.id ?? session.id;

    const existing = await this.ticketPurchaseModel
      .findOne({ stripePaymentIntentId })
      .lean()
      .select('_id');

    if (existing) {
      this.logger.warn(`Webhook dupliqué ignoré pour payment_intent : ${stripePaymentIntentId}`);
      return;
    }

    const quantity   = parseInt(meta.quantity, 10);
    const buyerId    = meta.buyerId || null;
    const guestEmail = meta.guestEmail || undefined;
    const unitPrice  = parseInt(meta.unitPrice, 10);

    let purchases: TicketPurchase[];
    try {
      purchases = await this.ticketsService.createPurchasesFromCheckout({
        ticketTypeId: meta.ticketTypeId,
        quantity,
        buyerId,
        guestEmail,
        price: unitPrice,
        stripePaymentIntentId,
      });
    } catch (err) {
      this.logger.error(`Erreur création billets (session ${session.id}) : ${String(err)}`);
      throw err;
    }

    const recipientEmail = guestEmail ?? null;
    if (recipientEmail) {
      const tt = await this.ticketTypeModel
        .findById(meta.ticketTypeId)
        .lean()
        .select('name');

      const qrCodes = purchases
        .map((p) => (p as TicketPurchase & { qrCode?: string }).qrCode)
        .filter((q): q is string => Boolean(q));

      await this.emailsService.sendTicketConfirmation(recipientEmail, {
        fullName:       meta.guestName || recipientEmail,
        eventTitle:     String((tt as (TicketType & { event?: Types.ObjectId }) | null)?.event ?? 'Événement'),
        ticketTypeName: tt?.name ?? 'Billet',
        quantity,
        totalPrice:     unitPrice * quantity,
        qrCodes,
      });
    }
  }
}
