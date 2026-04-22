import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TicketType, TicketTypeDocument, TicketPurchase, TicketPurchaseDocument } from './ticket.schema';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { Event, EventDocument } from '../events/event.schema';

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
}
