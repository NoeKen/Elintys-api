import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
import { Event, EventDocument } from '../events/event.schema';
import { generateQRCode } from '../../shared/utils/qr-code';

export type ScanResult = {
  purchase: TicketPurchase & { _id: Types.ObjectId };
  message: string;
};

@Injectable()
export class TicketsService {
  constructor(
    @InjectModel(TicketType.name) private readonly ticketTypeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketPurchase.name) private readonly ticketPurchaseModel: Model<TicketPurchaseDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
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
    const tt = await this.ticketTypeModel.create({ ...dto, event: new Types.ObjectId(eventId) });
    return tt.toObject();
  }

  async findTicketTypes(eventId: string): Promise<TicketType[]> {
    return this.ticketTypeModel.find({ event: new Types.ObjectId(eventId) }).lean().select('-__v');
  }

  async updateTicketType(id: string, organizerId: string, dto: UpdateTicketTypeDto): Promise<TicketType> {
    const tt = await this.ticketTypeModel.findById(id).lean().select('event');
    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    await this.assertEventOwner(tt.event.toString(), organizerId);

    const updated = await this.ticketTypeModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    return updated!;
  }

  async removeTicketType(id: string, organizerId: string): Promise<void> {
    const tt = await this.ticketTypeModel.findById(id).lean().select('event');
    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    await this.assertEventOwner(tt.event.toString(), organizerId);
    await this.ticketTypeModel.findByIdAndDelete(id);
  }

  async findMyTickets(buyerId: string): Promise<TicketPurchase[]> {
    return this.ticketPurchaseModel
      .find({ buyerId: new Types.ObjectId(buyerId) })
      .populate('event', 'title startDate')
      .populate('ticketType', 'name price')
      .lean()
      .select('-__v');
  }

  // Achat direct de billets gratuits (les billets payants passent par Stripe)
  async purchase(buyerId: string | null, dto: PurchaseTicketDto): Promise<TicketPurchase[]> {
    const tt = await this.ticketTypeModel
      .findById(dto.ticketTypeId)
      .lean()
      .select('event price isFree quantity sold');

    if (!tt) throw new NotFoundException('Type de billet introuvable.');
    if (!tt.isFree) {
      throw new BadRequestException('Ce billet est payant. Veuillez passer par le module de paiement.');
    }

    const available = tt.quantity - tt.sold;
    if (available < dto.quantity) {
      throw new BadRequestException(`Seulement ${available} billet(s) disponible(s).`);
    }

    const purchases = await Promise.all(
      Array.from({ length: dto.quantity }, () =>
        this.ticketPurchaseModel.create({
          event: tt.event,
          ticketType: new Types.ObjectId(dto.ticketTypeId),
          buyerId: buyerId ? new Types.ObjectId(buyerId) : null,
          guestEmail: dto.guestEmail,
          price: tt.price,
          qrCode: generateQRCode(dto.ticketTypeId),
          status: TicketPurchaseStatus.VALID,
        }),
      ),
    );

    await this.ticketTypeModel.findByIdAndUpdate(dto.ticketTypeId, { $inc: { sold: dto.quantity } });

    return purchases.map((p) => p.toObject()) as TicketPurchase[];
  }

  // Crée des achats après confirmation Stripe (appelé par PaymentsService)
  async createPurchasesFromCheckout(opts: {
    ticketTypeId: string;
    quantity: number;
    buyerId: string | null;
    guestEmail?: string;
    price: number;
    stripePaymentIntentId: string;
  }): Promise<TicketPurchase[]> {
    const tt = await this.ticketTypeModel
      .findById(opts.ticketTypeId)
      .lean()
      .select('event quantity sold');

    if (!tt) throw new NotFoundException('Type de billet introuvable.');

    const available = tt.quantity - tt.sold;
    if (available < opts.quantity) {
      throw new BadRequestException(`Stock insuffisant pour créer les billets.`);
    }

    const purchases = await Promise.all(
      Array.from({ length: opts.quantity }, () =>
        this.ticketPurchaseModel.create({
          event: tt.event,
          ticketType: new Types.ObjectId(opts.ticketTypeId),
          buyerId: opts.buyerId ? new Types.ObjectId(opts.buyerId) : null,
          guestEmail: opts.guestEmail,
          price: opts.price,
          qrCode: generateQRCode(opts.ticketTypeId),
          status: TicketPurchaseStatus.VALID,
          stripePaymentIntentId: opts.stripePaymentIntentId,
        }),
      ),
    );

    await this.ticketTypeModel.findByIdAndUpdate(opts.ticketTypeId, {
      $inc: { sold: opts.quantity },
    });

    return purchases.map((p) => p.toObject()) as TicketPurchase[];
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
