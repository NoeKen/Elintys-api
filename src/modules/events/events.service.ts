import {
  BadRequestException,
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
  EventDiscoverability,
  EventAccessPolicyType,
  AdmissionMode,
} from './event.schema';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { QueryEventDto } from './dto/query-event.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EventMediaService } from './event-media.service';
import { escapeRegExp } from '../../shared/utils/escape-regexp';
import { EventAccessService } from './event-access.service';
import { normalizeLegacyEventAccess, validateEventAccessConfiguration, validateEventPublishability } from './event-access.policy';
import { TicketType, TicketTypeDocument } from '../tickets/ticket.schema';

/**
 * Tri stable obligatoire sur toute requête paginée : sans ordre explicite,
 * `skip`/`limit` s'appuient sur l'ordre naturel de MongoDB, qui peut omettre
 * ou dupliquer des documents d'une page à l'autre. Le `_id` sert de départage.
 */
const PAGINATION_SORT = { createdAt: -1, _id: -1 } as const;

@Injectable()
export class EventsService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(TicketType.name) private readonly ticketTypeModel: Model<TicketTypeDocument>,
    private readonly eventMediaService: EventMediaService,
    private readonly eventAccessService: EventAccessService,
  ) {}

  async create(organizerId: string, dto: CreateEventDto): Promise<Event> {
    const baseSlug = slugify(dto.title, { lower: true, strict: true, locale: 'fr' });
    const slug = await this.generateUniqueSlug(baseSlug);
    const { accessPolicy, accessRules, visibility, ...eventInput } = dto;
    const preparedPolicy = accessPolicy
      ? await this.eventAccessService.preparePolicy(accessPolicy)
      : undefined;
    const accessCandidate = {
      ...eventInput,
      discoverability: eventInput.discoverability ?? EventDiscoverability.PUBLIC,
      accessPolicy: preparedPolicy ?? { type: EventAccessPolicyType.OPEN },
      admissionModes: eventInput.admissionModes ?? [AdmissionMode.REGISTRATION_ONLY],
    };
    const accessValidation = validateEventAccessConfiguration(accessCandidate);
    if (!accessValidation.valid) throw new BadRequestException(accessValidation.errors);
    const event = await this.eventModel.create({
      ...eventInput,
      ...(visibility ? { visibility } : {}),
      ...(accessRules ? { accessRules } : {}),
      ...(preparedPolicy ? { accessPolicy: preparedPolicy, accessModelVersion: 2 } : {}),
      organizer: new Types.ObjectId(organizerId),
      slug,
      creationProgress: {
        currentStep: dto.creationProgress?.currentStep ?? 1,
        completedSteps: dto.creationProgress?.completedSteps ?? [],
        skippedSteps: dto.creationProgress?.skippedSteps ?? [],
        lastSavedAt: new Date(),
      },
    });
    return this.eventAccessService.toSafeEvent(event.toObject());
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
      $or: [
        { discoverability: EventDiscoverability.PUBLIC },
        { accessModelVersion: { $exists: false }, visibility: EventVisibility.PUBLIC },
      ],
    };
    if (city) {
      filter['location.city'] = {
        $regex: escapeRegExp(city),
        $options: 'i',
      };
    }
    if (category) filter.eventType = category;

    const [data, total] = await Promise.all([
      this.eventModel.find(filter).sort(PAGINATION_SORT).skip(skip).limit(limit).lean().select('-__v'),
      this.eventModel.countDocuments(filter),
    ]);

    return { data: data.map((event) => this.eventAccessService.toPublicEvent(normalizeLegacyEventAccess(event))), total, page, limit };
  }

  async getPublicCategoryCounts(): Promise<{
    data: Array<{ category: string; count: number }>;
    total: number;
  }> {
    const filter = {
      status: EventStatus.PUBLISHED,
      $or: [
        { discoverability: EventDiscoverability.PUBLIC },
        { accessModelVersion: { $exists: false }, visibility: EventVisibility.PUBLIC },
      ],
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
        $or: [
          { discoverability: EventDiscoverability.PUBLIC },
          { accessModelVersion: { $exists: false }, visibility: EventVisibility.PUBLIC },
        ],
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
    return this.eventAccessService.toSafeEvent(normalizeLegacyEventAccess(event));
  }

  async update(id: string, organizerId: string, dto: UpdateEventDto): Promise<Event> {
    const event = await this.eventModel.findById(id).select('+accessPolicy.codeHash').lean();
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    const { accessPolicy, ...dtoWithoutAccessPolicy } = dto;
    const preparedPolicy = accessPolicy
      ? await this.eventAccessService.preparePolicy(accessPolicy, event.accessPolicy?.codeHash)
      : undefined;
    const normalizedDto = {
      ...dtoWithoutAccessPolicy,
      ...(preparedPolicy ? { accessPolicy: preparedPolicy, accessModelVersion: 2 } : {}),
    };
    if (dto.accessPolicy || dto.discoverability || dto.admissionModes) {
      const candidate = normalizeLegacyEventAccess({ ...event, ...normalizedDto });
      const validation = validateEventAccessConfiguration(candidate);
      if (!validation.valid) throw new BadRequestException(validation.errors);
    }
    const updatePayload = dto.creationProgress
      ? {
          ...normalizedDto,
          creationProgress: {
            ...dto.creationProgress,
            lastSavedAt: new Date(),
          },
        }
      : normalizedDto;

    const updated = await this.eventModel
      .findByIdAndUpdate(id, updatePayload, { new: true, runValidators: true })
      .lean()
      .select('-__v');
    return this.eventAccessService.toSafeEvent(updated!);
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
    const event = await this.eventModel.findById(id).select('+accessPolicy.codeHash').lean();
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    const readiness = await this.getPublishReadinessForEvent(event);
    if (!readiness.publishable) {
      throw new ConflictException({ code: 'EVENT_NOT_PUBLISHABLE', ...readiness });
    }
    return this.update(id, organizerId, { status: EventStatus.PUBLISHED } as UpdateEventDto);
  }

  async getPublishReadiness(id: string, organizerId: string) {
    const event = await this.eventModel.findById(id).select('+accessPolicy.codeHash').lean();
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    return this.getPublishReadinessForEvent(event);
  }

  private async getPublishReadinessForEvent(event: Event) {
    const [freeTicketTypes, paidTicketTypes] = await Promise.all([
      this.ticketTypeModel.countDocuments({ event: (event as Event & { _id: unknown })._id, isFree: true }),
      this.ticketTypeModel.countDocuments({ event: (event as Event & { _id: unknown })._id, isFree: false }),
    ]);
    return validateEventPublishability(normalizeLegacyEventAccess(event), { freeTicketTypes, paidTicketTypes });
  }

  async cancel(id: string, organizerId: string): Promise<Event> {
    return this.update(id, organizerId, { status: EventStatus.CANCELLED } as UpdateEventDto);
  }

  async findBySlug(slug: string): Promise<Event> {
    const event = await this.eventModel
      .findOne({
        slug,
        status: EventStatus.PUBLISHED,
        $or: [
          { discoverability: { $in: [EventDiscoverability.PUBLIC, EventDiscoverability.UNLISTED] } },
          { accessModelVersion: { $exists: false }, visibility: { $in: [EventVisibility.PUBLIC, EventVisibility.INVITE_ONLY] } },
        ],
      })
      .lean()
      .select('-__v -accessPolicy.codeHash');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    return this.eventAccessService.toPublicEvent(normalizeLegacyEventAccess(event));
  }

  async findByOrganizer(organizerId: string, query: QueryEventDto): Promise<PaginatedResult<Event>> {
    const { page = 1, limit = 20, status } = query;
    const skip = (page - 1) * limit;
    const filter: Record<string, unknown> = { organizer: new Types.ObjectId(organizerId) };
    if (status) filter['status'] = status;
    const [data, total] = await Promise.all([
      this.eventModel.find(filter).sort(PAGINATION_SORT).skip(skip).limit(limit).lean().select('-__v'),
      this.eventModel.countDocuments(filter),
    ]);
    return { data: data.map((event) => this.eventAccessService.toSafeEvent(normalizeLegacyEventAccess(event))), total, page, limit };
  }
}
