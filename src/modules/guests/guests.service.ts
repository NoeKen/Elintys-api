import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Guest, GuestDocument } from './guest.schema';
import { Event, EventDocument } from '../events/event.schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';

@Injectable()
export class GuestsService {
  constructor(
    @InjectModel(Guest.name) private readonly guestModel: Model<GuestDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
  ) {}

  private async assertEventOwner(eventId: string, userId: string): Promise<void> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.organizer.toString() !== userId) throw new ForbiddenException('Accès refusé.');
  }

  async create(eventId: string, userId: string, dto: CreateGuestDto): Promise<Guest> {
    await this.assertEventOwner(eventId, userId);
    const guest = await this.guestModel.create({
      ...dto,
      event: new Types.ObjectId(eventId),
      addedBy: new Types.ObjectId(userId),
    });
    return guest.toObject();
  }

  async findAll(eventId: string, userId: string, page = 1, limit = 50): Promise<PaginatedResult<Guest>> {
    await this.assertEventOwner(eventId, userId);
    const skip = (page - 1) * limit;
    const filter = { event: new Types.ObjectId(eventId) };

    const [data, total] = await Promise.all([
      this.guestModel.find(filter).skip(skip).limit(limit).lean().select('-__v'),
      this.guestModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  async update(id: string, eventId: string, userId: string, dto: UpdateGuestDto): Promise<Guest> {
    await this.assertEventOwner(eventId, userId);
    const guest = await this.guestModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    if (!guest) throw new NotFoundException('Invité introuvable.');
    return guest;
  }

  async remove(id: string, eventId: string, userId: string): Promise<void> {
    await this.assertEventOwner(eventId, userId);
    const result = await this.guestModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException('Invité introuvable.');
  }
}
