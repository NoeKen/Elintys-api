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
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EventAccessService } from '../events/event-access.service';
import { canManageEvent, canPurchaseTicket, normalizeLegacyEventAccess } from '../events/event-access.policy';
import { IdempotencyService } from '../../shared/consistency/idempotency/idempotency.service';
import { InsufficientCapacityError } from '../../shared/consistency/errors/consistency.errors';

/**
 * Issue d'un scan, décidée par le SERVEUR.
 *
 * `outcome` est un code stable : le client ne dérive jamais l'état d'un billet
 * en interprétant `message`, qui n'est qu'un libellé humain.
 */
export type ScanOutcome = 'admitted' | 'already_used';

export type ScanResult = {
  purchase: TicketPurchase & { _id: Types.ObjectId };
  outcome: ScanOutcome;
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

  /**
   * `canManageEvent` porte la politique du produit — propriétaire OU admin —
   * et est déjà appliquée au scan. La comparaison directe utilisée ici
   * refusait un ADMIN que le contrôleur annonçait pourtant.
   */
  private async assertEventOwner(
    eventId: string,
    organizerId: string,
    roles: string[] = [],
  ): Promise<void> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId: organizerId, roles }, event as never).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
  }

  async createTicketType(eventId: string, organizerId: string, dto: CreateTicketTypeDto, roles: string[] = []): Promise<TicketType> {
    await this.assertEventOwner(eventId, organizerId, roles);
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

  async findManagedTicketTypes(eventId: string, organizerId: string, roles: string[] = []): Promise<TicketType[]> {
    await this.assertEventOwner(eventId, organizerId, roles);
    return this.ticketTypeModel
      .find({ event: new Types.ObjectId(eventId) })
      .sort({ price: 1, _id: 1 })
      .lean()
      .select('-__v');
  }

  async updateTicketType(id: string, organizerId: string, dto: UpdateTicketTypeDto, roles: string[] = []): Promise<TicketType> {
    const tt = await this.ticketTypeModel
      .findById(id)
      .lean()
      .select('event sold reserved price isFree');
    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    await this.assertEventOwner(tt.event.toString(), organizerId, roles);

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

  async removeTicketType(id: string, organizerId: string, roles: string[] = []): Promise<void> {
    const tt = await this.ticketTypeModel.findById(id).lean().select('event sold reserved');
    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    await this.assertEventOwner(tt.event.toString(), organizerId, roles);
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

  /**
   * Validation d'un billet à l'entrée.
   *
   * Trois propriétés tenues par cette implémentation :
   *
   * 1. **Autorisation d'abord.** L'appelant doit pouvoir gérer l'événement
   *    scanné AVANT toute lecture du billet. Un organisateur ne peut donc pas
   *    sonder l'existence d'un code QR appartenant à l'événement d'autrui.
   *
   * 2. **Billet lié à l'événement.** Le filtre porte `event: eventId` : un
   *    billet de l'événement B est refusé au scanner de l'événement A, même
   *    si son code QR est valide.
   *
   * 3. **Transition atomique.** `findOneAndUpdate` avec `status: VALID` dans le
   *    filtre : deux scans simultanés du même billet ont exactement un
   *    gagnant. L'ancienne séquence lecture → vérification → écriture laissait
   *    passer deux admissions pour un seul billet.
   */
  async scan(
    eventId: string,
    qrCode: string,
    userId: string,
    roles: string[] = [],
  ): Promise<ScanResult> {
    await this.assertCanScanEvent(eventId, userId, roles);

    const admitted = await this.ticketPurchaseModel
      .findOneAndUpdate(
        {
          qrCode,
          event: new Types.ObjectId(eventId),
          status: TicketPurchaseStatus.VALID,
        },
        {
          status: TicketPurchaseStatus.USED,
          scannedAt: new Date(),
          scannedBy: new Types.ObjectId(userId),
        },
        { new: true },
      )
      .lean()
      .select('_id event status scannedAt ticketType buyerId');

    if (admitted) {
      return {
        purchase: admitted as TicketPurchase & { _id: Types.ObjectId },
        outcome: 'admitted',
        message: 'Billet scanné avec succès.',
      };
    }

    return this.explainFailedScan(eventId, qrCode);
  }

  /**
   * Distingue les causes d'un scan non admis.
   *
   * La recherche est restreinte à l'événement autorisé : un code QR d'un autre
   * événement est indiscernable d'un code inexistant (`QR_NOT_FOUND`). C'est
   * volontaire — on ne confirme pas à l'organisateur A l'existence d'un billet
   * de l'organisateur B.
   */
  private async explainFailedScan(eventId: string, qrCode: string): Promise<ScanResult> {
    const purchase = await this.ticketPurchaseModel
      .findOne({ qrCode, event: new Types.ObjectId(eventId) })
      .lean()
      .select('_id event status scannedAt ticketType buyerId');

    if (!purchase) throw new NotFoundException(ErrorCodes.QR_NOT_FOUND);

    if (purchase.status === TicketPurchaseStatus.USED) {
      // Cas métier, pas une erreur : le portier doit voir QUAND il a été utilisé.
      return {
        purchase: purchase as TicketPurchase & { _id: Types.ObjectId },
        outcome: 'already_used',
        message: `Billet déjà utilisé le ${purchase.scannedAt?.toLocaleString('fr-CA') ?? '—'}.`,
      };
    }

    if (purchase.status === TicketPurchaseStatus.CANCELLED) {
      throw new BadRequestException(ErrorCodes.QR_CANCELLED);
    }

    throw new BadRequestException(ErrorCodes.QR_NOT_VALID);
  }

  /**
   * Le rôle ORGANISATEUR ne suffit pas : il faut pouvoir gérer CET événement.
   * `canManageEvent` porte la politique du produit (propriétaire ou admin) et
   * est la même que celle appliquée partout ailleurs sur les événements.
   */
  private async assertCanScanEvent(eventId: string, userId: string, roles: string[]): Promise<void> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId, roles }, event).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
  }

  async linkGuestPurchases(email: string, userId: string): Promise<void> {
    await this.ticketPurchaseModel.updateMany(
      { guestEmail: email.toLowerCase(), buyerId: null },
      { buyerId: new Types.ObjectId(userId) },
    );
  }
}
