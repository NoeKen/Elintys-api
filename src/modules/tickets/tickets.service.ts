import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  TicketType,
  TicketTypeDocument,
  TicketPurchase,
  TicketPurchaseDocument,
  TicketPurchaseStatus,
} from './ticket.schema';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { Event, EventDiscoverability, EventDocument, EventStatus } from '../events/event.schema';
import { generateQRCode } from '../../shared/utils/qr-code';
import { EventAccessService } from '../events/event-access.service';
import { canPurchaseTicket, normalizeLegacyEventAccess } from '../events/event-access.policy';
import { IdempotencyService } from '../../shared/consistency/idempotency/idempotency.service';
import { InsufficientCapacityError } from '../../shared/consistency/errors/consistency.errors';

export type ScanResult = {
  purchase: TicketPurchase & { _id: Types.ObjectId };
  message: string;
};

export type TicketPurchaseResult = {
  _id: string;
  event: string;
  ticketType: string;
  price: number;
  qrCode?: string;
  status: TicketPurchaseStatus;
};

/** Projection minimale retournée à PaymentsService pour finalisation + email. */
export type CreatedPurchaseInfo = {
  _id: Types.ObjectId;
  qrCode?: string;
};

@Injectable()
export class TicketsService {
  constructor(
    @InjectModel(TicketType.name) private readonly ticketTypeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketPurchase.name) private readonly ticketPurchaseModel: Model<TicketPurchaseDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    private readonly eventAccessService: EventAccessService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  private async assertEventOwner(eventId: string, organizerId: string): Promise<void> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException('Accès refusé.');
    }
  }

  async createTicketType(eventId: string, organizerId: string, dto: CreateTicketTypeDto): Promise<TicketType> {
    await this.assertEventOwner(eventId, organizerId);
    if (!dto.isFree && (!dto.price || dto.price <= 0)) {
      throw new BadRequestException('PAID_TICKET_PRICE_REQUIRED');
    }
    const tt = await this.ticketTypeModel.create({
      ...dto,
      price: dto.isFree ? 0 : dto.price,
      event: new Types.ObjectId(eventId),
    });
    return tt.toObject();
  }

  async findTicketTypes(eventId: string): Promise<TicketType[]> {
    const event = await this.eventModel.findById(eventId).lean().select('status archivedAt discoverability visibility accessModelVersion');
    if (!event || event.status !== EventStatus.PUBLISHED || event.archivedAt) {
      throw new NotFoundException('Événement introuvable.');
    }
    if (normalizeLegacyEventAccess(event).discoverability === EventDiscoverability.PRIVATE) {
      throw new NotFoundException('Événement introuvable.');
    }
    return this.ticketTypeModel.find({ event: new Types.ObjectId(eventId) }).lean().select('-__v');
  }

  async findManagedTicketTypes(eventId: string, organizerId: string): Promise<TicketType[]> {
    await this.assertEventOwner(eventId, organizerId);
    return this.ticketTypeModel
      .find({ event: new Types.ObjectId(eventId) })
      .sort({ price: 1, _id: 1 })
      .lean()
      .select('-__v');
  }

  async updateTicketType(id: string, organizerId: string, dto: UpdateTicketTypeDto): Promise<TicketType> {
    const tt = await this.ticketTypeModel
      .findById(id)
      .lean()
      .select('event sold reserved price isFree');
    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    await this.assertEventOwner(tt.event.toString(), organizerId);

    const committed = (tt.sold ?? 0) + (tt.reserved ?? 0);
    if (dto.quantity !== undefined && dto.quantity < committed) {
      throw new BadRequestException('TICKET_QUANTITY_BELOW_SOLD');
    }
    const nextIsFree = dto.isFree ?? tt.isFree;
    const nextPrice = nextIsFree ? 0 : (dto.price ?? tt.price);
    if (!nextIsFree && nextPrice <= 0) {
      throw new BadRequestException('PAID_TICKET_PRICE_REQUIRED');
    }

    // Le filtre conditionnel ferme la race entre la lecture ci-dessus et une
    // nouvelle réservation concurrente : la capacité ne peut jamais passer
    // sous `sold + reserved`.
    const updated = await this.ticketTypeModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          ...(dto.quantity === undefined
            ? {}
            : {
                $expr: {
                  $lte: [
                    {
                      $add: [
                        { $ifNull: ['$sold', 0] },
                        { $ifNull: ['$reserved', 0] },
                      ],
                    },
                    dto.quantity,
                  ],
                },
              }),
        },
        { ...dto, price: nextPrice },
        { new: true, runValidators: true },
      )
      .lean()
      .select('-__v');
    if (!updated) throw new BadRequestException('TICKET_QUANTITY_BELOW_SOLD');
    return updated;
  }

  async removeTicketType(id: string, organizerId: string): Promise<void> {
    const tt = await this.ticketTypeModel.findById(id).lean().select('event sold reserved');
    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    await this.assertEventOwner(tt.event.toString(), organizerId);
    if ((tt.sold ?? 0) + (tt.reserved ?? 0) > 0) {
      throw new BadRequestException('TICKET_TYPE_HAS_SALES');
    }
    // Une réservation peut apparaître après le contrôle d'ownership. La
    // suppression est donc elle aussi conditionnelle à un stock non engagé.
    const removed = await this.ticketTypeModel.findOneAndDelete({
      _id: new Types.ObjectId(id),
      $expr: {
        $eq: [
          {
            $add: [
              { $ifNull: ['$sold', 0] },
              { $ifNull: ['$reserved', 0] },
            ],
          },
          0,
        ],
      },
    });
    if (!removed) throw new BadRequestException('TICKET_TYPE_HAS_SALES');
  }

  async findMyTickets(buyerId: string): Promise<TicketPurchase[]> {
    return this.ticketPurchaseModel
      .find({ buyerId: new Types.ObjectId(buyerId) })
      .populate('event', 'title startDate slug')
      .populate('ticketType', 'name price isFree')
      .lean()
      .select('-__v')
      .sort({ createdAt: -1 });
  }

  // Achat direct de billets gratuits (les billets payants passent par Stripe)
  async purchase(
    buyerId: string,
    dto: PurchaseTicketDto,
    idempotencyKey: string,
    accessGrant?: string,
  ): Promise<TicketPurchaseResult[]> {
    if (!buyerId) throw new BadRequestException('BUYER_REQUIRED');

    return this.idempotencyService.execute<TicketPurchaseResult[]>({
      scope: 'ticket-purchase',
      actorId: buyerId,
      idempotencyKey,
      payload: { ticketTypeId: dto.ticketTypeId, quantity: dto.quantity },
      operation: async (session: ClientSession) => {
        const tt = await this.ticketTypeModel
          .findById(dto.ticketTypeId)
          .session(session)
          .lean()
          .select('event price isFree quantity sold reserved');

        if (!tt) throw new NotFoundException('Type de billet introuvable.');
        if (!tt.isFree) {
          throw new BadRequestException('Ce billet est payant. Veuillez passer par le module de paiement.');
        }

        const event = await this.eventModel
          .findById(tt.event)
          .session(session)
          .lean()
          .select('-accessPolicy.codeHash');
        if (!event) throw new NotFoundException('Événement introuvable.');

        const actor = await this.eventAccessService.buildActor(
          buyerId,
          tt.event.toString(),
          accessGrant,
          session,
        );
        const decision = canPurchaseTicket(actor, normalizeLegacyEventAccess(event));
        if (!decision.allowed) throw new ForbiddenException(decision.reason);

        // Réservation atomique du stock — DB comme dernière ligne de défense
        const reserved = await this.ticketTypeModel.findOneAndUpdate(
          {
            _id: new Types.ObjectId(dto.ticketTypeId),
            isFree: true,
            $expr: {
              $lte: [
                {
                  $add: [
                    { $ifNull: ['$sold', 0] },
                    { $ifNull: ['$reserved', 0] },
                    dto.quantity,
                  ],
                },
                '$quantity',
              ],
            },
          },
          { $inc: { sold: dto.quantity } },
          { new: true, session },
        );
        if (!reserved) throw new InsufficientCapacityError();

        // Création séquentielle — jamais Promise.all dans une transaction MongoDB
        const purchases: TicketPurchaseResult[] = [];
        for (let i = 0; i < dto.quantity; i++) {
          const [p] = await this.ticketPurchaseModel.create(
            [
              {
                event: reserved.event,
                ticketType: new Types.ObjectId(dto.ticketTypeId),
                buyerId: new Types.ObjectId(buyerId),
                guestEmail: null,
                guestName: null,
                price: reserved.price,
                qrCode: generateQRCode(dto.ticketTypeId),
                status: TicketPurchaseStatus.VALID,
              },
            ],
            { session },
          );
          const created = p.toObject() as TicketPurchase & { _id: Types.ObjectId };
          purchases.push({
            _id: created._id.toString(),
            event: created.event.toString(),
            ticketType: created.ticketType.toString(),
            price: created.price,
            qrCode: created.qrCode,
            status: created.status,
          });
        }
        return purchases;
      },
      toReplayResult: (purchases) => purchases,
    });
  }

  /**
   * Crée les billets après confirmation Stripe.
   *
   * Contrat :
   * - Reçoit explicitement la ClientSession — toutes les mutations sont dans
   *   la même transaction que la transition SUCCEEDED de la finalisation
   *   (orchestrée par PaymentsService).
   * - Réservation atomique du stock via $expr (dernière ligne de défense DB).
   * - Création séquentielle des N billets — jamais Promise.all dans une transaction.
   * - Retourne une projection minimale (id + qrCode) — la finalisation stocke
   *   les ids, l'email consomme les qrCodes.
   */
  async createPurchasesFromCheckout(
    opts: {
      ticketTypeId: string;
      quantity: number;
      buyerId: string | null;
      guestEmail?: string;
      price: number;
      stripePaymentIntentId: string;
    },
    session: ClientSession,
  ): Promise<CreatedPurchaseInfo[]> {
    // Réservation atomique — jamais findById + check + $inc séparés
    const reserved = await this.ticketTypeModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(opts.ticketTypeId),
        isFree: false,
        $expr: {
          $lte: [
            {
              $add: [
                { $ifNull: ['$sold', 0] },
                { $ifNull: ['$reserved', 0] },
                opts.quantity,
              ],
            },
            '$quantity',
          ],
        },
      },
      { $inc: { sold: opts.quantity } },
      { new: true, session },
    );
    if (!reserved) throw new InsufficientCapacityError();

    // Création séquentielle — jamais Promise.all dans une transaction MongoDB
    const created: CreatedPurchaseInfo[] = [];
    for (let i = 0; i < opts.quantity; i++) {
      const [p] = await this.ticketPurchaseModel.create(
        [
          {
            event: reserved.event,
            ticketType: new Types.ObjectId(opts.ticketTypeId),
            buyerId: opts.buyerId ? new Types.ObjectId(opts.buyerId) : null,
            guestEmail: opts.guestEmail ?? null,
            price: opts.price,
            qrCode: generateQRCode(opts.ticketTypeId),
            status: TicketPurchaseStatus.VALID,
            stripePaymentIntentId: opts.stripePaymentIntentId,
          },
        ],
        { session },
      );
      const doc = p as TicketPurchase & { _id: Types.ObjectId; qrCode?: string };
      created.push({ _id: doc._id, qrCode: doc.qrCode });
    }
    return created;
  }

  async scan(qrCode: string, organizerId: string): Promise<ScanResult> {
    const purchase = await this.ticketPurchaseModel
      .findOne({ qrCode })
      .lean()
      .select('_id event status scannedAt ticketType buyerId');

    if (!purchase) throw new NotFoundException('Code QR invalide ou introuvable.');

    await this.assertEventOwner(purchase.event.toString(), organizerId);

    if (purchase.status === TicketPurchaseStatus.USED) {
      return {
        purchase: purchase as TicketPurchase & { _id: Types.ObjectId },
        message: `Billet déjà utilisé le ${purchase.scannedAt?.toLocaleString('fr-CA') ?? '—'}.`,
      };
    }

    if (purchase.status !== TicketPurchaseStatus.VALID) {
      throw new BadRequestException(`Billet non valide (statut : ${purchase.status}).`);
    }

    await this.ticketPurchaseModel.findByIdAndUpdate(purchase._id, {
      status: TicketPurchaseStatus.USED,
      scannedAt: new Date(),
    });

    return {
      purchase: purchase as TicketPurchase & { _id: Types.ObjectId },
      message: 'Billet scanné avec succès.',
    };
  }

  async linkGuestPurchases(email: string, userId: string): Promise<void> {
    await this.ticketPurchaseModel.updateMany(
      { guestEmail: email.toLowerCase(), buyerId: null },
      { buyerId: new Types.ObjectId(userId) },
    );
  }
}
