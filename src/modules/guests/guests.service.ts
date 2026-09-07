import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { canManageEvent } from '../events/event-access.policy';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { Guest, GuestDocument } from './guest.schema';
import { Event, EventDocument } from '../events/event.schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { BulkCreateGuestDto } from './dto/bulk-create-guest.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';

@Injectable()
export class GuestsService {
  constructor(
    @InjectModel(Guest.name) private readonly guestModel: Model<GuestDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
  ) {}

  /**
   * `canManageEvent` porte la politique du produit — propriétaire OU admin.
   * La comparaison directe refusait un ADMIN que le contrôleur annonçait.
   * `roles` vaut `[]` par défaut : appelant sans rôles ⇒ propriétaire strict.
   */
  private async assertCanManage(
    eventId: string,
    userId: string,
    roles: string[] = [],
  ): Promise<void> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId, roles }, event as never).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
  }

  async create(eventId: string, userId: string, dto: CreateGuestDto, roles: string[] = []): Promise<Guest> {
    await this.assertCanManage(eventId, userId, roles);
    const guest = await this.guestModel.create({
      ...dto,
      event: new Types.ObjectId(eventId),
      addedBy: new Types.ObjectId(userId),
    });
    return guest.toObject();
  }

  async findAll(eventId: string, userId: string, page = 1, limit = 50, roles: string[] = []): Promise<PaginatedResult<Guest>> {
    await this.assertCanManage(eventId, userId, roles);
    const skip = (page - 1) * limit;
    const filter = { event: new Types.ObjectId(eventId) };

    const [data, total] = await Promise.all([
      this.guestModel.find(filter).skip(skip).limit(limit).lean().select('-__v'),
      this.guestModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  async update(id: string, eventId: string, userId: string, dto: UpdateGuestDto, roles: string[] = []): Promise<Guest> {
    await this.assertCanManage(eventId, userId, roles);
    const guest = await this.guestModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    if (!guest) throw new NotFoundException('Invité introuvable.');
    return guest;
  }

  async remove(id: string, eventId: string, userId: string, roles: string[] = []): Promise<void> {
    await this.assertCanManage(eventId, userId, roles);
    const result = await this.guestModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException('Invité introuvable.');
  }

  async bulkCreate(eventId: string, userId: string, dto: BulkCreateGuestDto, roles: string[] = []): Promise<{ created: number }> {
    await this.assertCanManage(eventId, userId, roles);
    const docs = dto.guests.map((g) => ({
      ...g,
      event: new Types.ObjectId(eventId),
      addedBy: new Types.ObjectId(userId),
    }));
    await this.guestModel.insertMany(docs, { ordered: false });
    return { created: docs.length };
  }
}
