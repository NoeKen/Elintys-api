import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import slugify from 'slugify';
import {
  Event,
  EventDocument,
  EventStatus,
  EventVisibility,
} from './event.schema';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { QueryEventDto } from './dto/query-event.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EventMediaService } from './event-media.service';
import { escapeRegExp } from '../../shared/utils/escape-regexp';

@Injectable()
export class EventsService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    private readonly eventMediaService: EventMediaService,
  ) {}

  async create(organizerId: string, dto: CreateEventDto): Promise<Event> {
    const baseSlug = slugify(dto.title, { lower: true, strict: true, locale: 'fr' });
    const slug = await this.generateUniqueSlug(baseSlug);
    const event = await this.eventModel.create({
      ...dto,
      organizer: new Types.ObjectId(organizerId),
      slug,
      creationProgress: {
        currentStep: dto.creationProgress?.currentStep ?? 1,
        completedSteps: dto.creationProgress?.completedSteps ?? [],
        skippedSteps: dto.creationProgress?.skippedSteps ?? [],
        lastSavedAt: new Date(),
      },
    });
    return event.toObject();
  }

  private async generateUniqueSlug(base: string): Promise<string> {
    const MAX_ATTEMPTS = 20;
    let candidate = base;
    let counter = 2;
    while (counter <= MAX_ATTEMPTS + 2) {
      const existing = await this.eventModel.findOne({ slug: candidate }).lean().select('_id');
      if (!existing) return candidate;
      candidate = `${base}-${counter++}`;
    }
    throw new ConflictException('Impossible de générer un slug unique pour cet événement.');
  }

  async findAll(query: QueryEventDto): Promise<PaginatedResult<Event>> {
    const { page = 1, limit = 20, city, category } = query;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      status: EventStatus.PUBLISHED,
      visibility: EventVisibility.PUBLIC,
    };
    if (city) {
      filter['location.city'] = {
        $regex: escapeRegExp(city),
        $options: 'i',
      };
    }
    if (category) filter.eventType = category;

    const [data, total] = await Promise.all([
      this.eventModel.find(filter).skip(skip).limit(limit).lean().select('-__v'),
      this.eventModel.countDocuments(filter),
    ]);

    return { data, total, page, limit };
  }

  async getPublicCategoryCounts(): Promise<{
    data: Array<{ category: string; count: number }>;
    total: number;
  }> {
    const filter = {
      status: EventStatus.PUBLISHED,
      visibility: EventVisibility.PUBLIC,
      eventType: { $exists: true, $ne: null },
    };
    const [groups, total] = await Promise.all([
      this.eventModel.aggregate<{ _id: string; count: number }>([
        { $match: filter },
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
      this.eventModel.countDocuments({
        status: EventStatus.PUBLISHED,
        visibility: EventVisibility.PUBLIC,
      }),
    ]);

    return {
      data: groups.map(({ _id, count }) => ({ category: _id, count })),
      total,
    };
  }

  async findOne(id: string, organizerId: string): Promise<Event> {
    const event = await this.eventModel.findById(id).lean().select('-__v');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
    return event;
  }

  async update(id: string, organizerId: string, dto: UpdateEventDto): Promise<Event> {
    const event = await this.eventModel.findById(id).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    const updatePayload = dto.creationProgress
      ? {
          ...dto,
          creationProgress: {
            ...dto.creationProgress,
            lastSavedAt: new Date(),
          },
        }
      : dto;

    const updated = await this.eventModel
      .findByIdAndUpdate(id, updatePayload, { new: true, runValidators: true })
      .lean()
      .select('-__v');
    return updated!;
  }

  async remove(id: string, organizerId: string): Promise<void> {
    const event = await this.eventModel
      .findById(id)
      .lean()
      .select('organizer coverImage gallery');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
    await this.eventModel.findByIdAndDelete(id);
    await this.eventMediaService.cleanupAfterEventDeletion(id, event);
  }

  async publish(id: string, organizerId: string): Promise<Event> {
    return this.update(id, organizerId, { status: EventStatus.PUBLISHED } as UpdateEventDto);
  }

  async cancel(id: string, organizerId: string): Promise<Event> {
    return this.update(id, organizerId, { status: EventStatus.CANCELLED } as UpdateEventDto);
  }

  async findBySlug(slug: string): Promise<Event> {
    const event = await this.eventModel
      .findOne({ slug, status: EventStatus.PUBLISHED })
      .lean()
      .select('-__v');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    return event;
  }

  async findByOrganizer(organizerId: string, query: QueryEventDto): Promise<PaginatedResult<Event>> {
    const { page = 1, limit = 20, status } = query;
    const skip = (page - 1) * limit;
    const filter: Record<string, unknown> = { organizer: new Types.ObjectId(organizerId) };
    if (status) filter['status'] = status;
    const [data, total] = await Promise.all([
      this.eventModel.find(filter).skip(skip).limit(limit).lean().select('-__v'),
      this.eventModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }
}
