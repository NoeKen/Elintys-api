import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event, EventDocument, EventStatus } from './event.schema';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { QueryEventDto } from './dto/query-event.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';

@Injectable()
export class EventsService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
  ) {}

  async create(organizerId: string, dto: CreateEventDto): Promise<Event> {
    const event = await this.eventModel.create({
      ...dto,
      organizer: new Types.ObjectId(organizerId),
    });
    return event.toObject();
  }

  async findAll(query: QueryEventDto): Promise<PaginatedResult<Event>> {
    const { page = 1, limit = 20, status, visibility, city } = query;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (status) filter['status'] = status;
    if (visibility) filter['visibility'] = visibility;
    if (city) filter['location.city'] = { $regex: city, $options: 'i' };

    const [data, total] = await Promise.all([
      this.eventModel.find(filter).skip(skip).limit(limit).lean().select('-__v'),
      this.eventModel.countDocuments(filter),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string): Promise<Event> {
    const event = await this.eventModel.findById(id).lean().select('-__v');
    if (!event) throw new NotFoundException('Événement introuvable.');
    return event;
  }

  async update(id: string, organizerId: string, dto: UpdateEventDto): Promise<Event> {
    const event = await this.eventModel.findById(id).lean().select('organizer');
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException("Vous n'êtes pas l'organisateur de cet événement.");
    }

    const updated = await this.eventModel
      .findByIdAndUpdate(id, dto, { new: true })
      .lean()
      .select('-__v');
    return updated!;
  }

  async remove(id: string, organizerId: string): Promise<void> {
    const event = await this.eventModel.findById(id).lean().select('organizer');
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException("Vous n'êtes pas l'organisateur de cet événement.");
    }
    await this.eventModel.findByIdAndDelete(id);
  }

  async publish(id: string, organizerId: string): Promise<Event> {
    return this.update(id, organizerId, { status: EventStatus.PUBLISHED } as UpdateEventDto);
  }

  async cancel(id: string, organizerId: string): Promise<Event> {
    return this.update(id, organizerId, { status: EventStatus.CANCELLED } as UpdateEventDto);
  }
}
