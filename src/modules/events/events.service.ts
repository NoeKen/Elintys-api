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
import {
  OrganizerEventDate,
  OrganizerEventProgress,
  OrganizerEventSort,
  OrganizerEventView,
  QueryEventDto,
} from './dto/query-event.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EventMediaService } from './event-media.service';
import { escapeRegExp } from '../../shared/utils/escape-regexp';
import { EventAccessService } from './event-access.service';
import {
  canManageEvent,
  normalizeLegacyEventAccess,
  PublishabilityResult,
  validateEventAccessConfiguration,
  validateEventPublishability,
} from './event-access.policy';
import { TicketType, TicketTypeDocument } from '../tickets/ticket.schema';
import {
  EventAccessRequest,
  EventAccessRequestDocument,
  EventAccessRequestStatus,
} from './event-access-request.schema';
import { User, UserDocument } from '../auth/user.schema';
import { VenueProfile, VenueProfileDocument } from '../venues/venue.schema';
import {
  VendorProfile,
  VendorProfileDocument,
  VendorRequest,
  VendorRequestDocument,
  VendorRequestStatus,
} from '../vendors/vendor.schema';
import {
  PublicEventDetail,
  PublicEventLocation,
  PublicEventMedia,
  PublicEventProvider,
  PublicEventTicketType,
  PublicEventVenue,
  PublicRelatedEvent,
} from './dto/public-event-detail.dto';

/**
 * Tri stable obligatoire sur toute requête paginée : sans ordre explicite,
 * `skip`/`limit` s'appuient sur l'ordre naturel de MongoDB, qui peut omettre
 * ou dupliquer des documents d'une page à l'autre. Le `_id` sert de départage.
 */
const PAGINATION_SORT = { createdAt: -1, _id: -1 } as const;
const ORGANIZER_SCAN_BATCH_SIZE = 100;
const UPCOMING_WINDOW_DAYS = 30;

export type OrganizerActionCode =
  | 'REVIEW_ACCESS_REQUESTS'
  | 'COMPLETE_INFORMATION'
  | 'COMPLETE_SCHEDULE'
  | 'ADD_VENUE'
  | 'ADD_COVER'
  | 'CONFIGURE_ACCESS'
  | 'CONFIGURE_TICKETS'
  | 'CONTINUE_CREATION'
  | 'PUBLISH_EVENT';

export interface OrganizerEventListItem extends Event {
  readiness: PublishabilityResult;
  pendingAccessRequests: number;
}

export interface OrganizerDashboardAction {
  code: OrganizerActionCode;
  priority: 'high' | 'medium' | 'low';
  event: OrganizerEventListItem;
  progress: number;
  requestCount?: number;
}

export interface OrganizerDashboardSummary {
  metrics: {
    totalEvents: number;
    activeEvents: number;
    upcomingEvents: number;
    draftEvents: number;
    pendingActions: number;
  };
  actions: OrganizerDashboardAction[];
  upcoming: OrganizerEventListItem[];
  activityAvailable: false;
}

@Injectable()
export class EventsService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(TicketType.name) private readonly ticketTypeModel: Model<TicketTypeDocument>,
    @InjectModel(EventAccessRequest.name) private readonly accessRequestModel: Model<EventAccessRequestDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
    @InjectModel(VendorRequest.name) private readonly vendorRequestModel: Model<VendorRequestDocument>,
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
      archivedAt: null,
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
      archivedAt: null,
    };
    const [groups, total] = await Promise.all([
      this.eventModel.aggregate<{ _id: string; count: number }>([
        { $match: filter },
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
      this.eventModel.countDocuments({
        status: EventStatus.PUBLISHED,
        archivedAt: null,
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
    if (event.archivedAt) throw new ConflictException('EVENT_ARCHIVED');
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

  async findBySlug(slug: string): Promise<PublicEventDetail> {
    const event = await this.eventModel
      .findOne({
        slug,
        status: EventStatus.PUBLISHED,
        archivedAt: null,
        $or: [
          { discoverability: { $in: [EventDiscoverability.PUBLIC, EventDiscoverability.UNLISTED] } },
          { accessModelVersion: { $exists: false }, visibility: { $in: [EventVisibility.PUBLIC, EventVisibility.INVITE_ONLY] } },
        ],
      })
      .lean()
      .select('-__v -accessPolicy.codeHash');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    const normalized = normalizeLegacyEventAccess(event);
    const eventId = (normalized as Event & { _id: Types.ObjectId })._id;
    const hasTicketAdmission = normalized.admissionModes.some((mode) =>
      [AdmissionMode.FREE_TICKET, AdmissionMode.PAID_TICKET].includes(mode),
    );
    const relatedFilter = this.buildRelatedPublicFilter(normalized, eventId);

    const [organizer, venue, acceptedRequests, ticketTypes, relatedEvents] = await Promise.all([
      this.userModel.findById(normalized.organizer).lean().select('fullName'),
      normalized.venueProfile
        ? this.venueModel.findOne({ _id: normalized.venueProfile, isActive: true }).lean().select(
          'name type description address capacity photos amenities rating reviewCount',
        )
        : null,
      this.vendorRequestModel
        .find({ event: eventId, status: VendorRequestStatus.ACCEPTED, vendor: { $ne: null } })
        .lean()
        .select('vendor'),
      hasTicketAdmission
        ? this.ticketTypeModel
          .find({ event: eventId })
          .sort({ price: 1, _id: 1 })
          .lean()
          .select('name price isFree quantity sold reserved description')
        : [],
      relatedFilter
        ? this.eventModel
          .find(relatedFilter)
          .sort({ startDate: 1, _id: 1 })
          .limit(4)
          .lean()
          .select('slug title shortDescription eventType coverImage startDate endDate location')
        : [],
    ]);

    const vendorIds = Array.from(new Set(
      acceptedRequests
        .map((request) => request.vendor?.toString())
        .filter((id): id is string => Boolean(id)),
    ));
    const providers = vendorIds.length
      ? await this.vendorModel
        .find({ _id: { $in: vendorIds }, isActive: true })
        .lean()
        .select('businessName category description photos serviceArea rating reviewCount')
      : [];

    return this.toPublicEventDetail({
      event: normalized,
      organizer,
      venue,
      providers,
      ticketTypes,
      relatedEvents,
    });
  }

  private buildRelatedPublicFilter(event: Event, eventId: Types.ObjectId): Record<string, unknown> | null {
    const relevance: Record<string, unknown>[] = [];
    if (event.eventType) relevance.push({ eventType: event.eventType });
    if (event.location?.city) relevance.push({ 'location.city': event.location.city });
    if (relevance.length === 0) return null;
    return {
      _id: { $ne: eventId },
      status: EventStatus.PUBLISHED,
      archivedAt: null,
      discoverability: EventDiscoverability.PUBLIC,
      startDate: { $gte: new Date() },
      $or: relevance,
    };
  }

  private toPublicEventDetail(input: {
    event: Event;
    organizer: Pick<User, 'fullName'> | null;
    venue: VenueProfile | null;
    providers: VendorProfile[];
    ticketTypes: TicketType[];
    relatedEvents: Event[];
  }): PublicEventDetail {
    const { event } = input;
    const accessType = event.accessPolicy?.type ?? EventAccessPolicyType.OPEN;
    const detail: PublicEventDetail = {
      _id: this.idOf(event),
      slug: event.slug!,
      title: event.title,
      ...(event.shortDescription ? { shortDescription: event.shortDescription } : {}),
      ...(event.description ? { description: event.description } : {}),
      ...(event.eventType ? { eventType: event.eventType } : {}),
      ...(event.coverImage ? { coverImage: event.coverImage as PublicEventMedia | string } : {}),
      gallery: (event.gallery ?? []) as PublicEventMedia[],
      startDate: event.startDate!,
      ...(event.endDate ? { endDate: event.endDate } : {}),
      timezone: event.timezone ?? 'America/Toronto',
      dateIsTentative: Boolean(event.dateIsTentative),
      ...(event.location ? { location: this.toPublicLocation(event.location) } : {}),
      ...(event.capacity > 0 ? { capacity: event.capacity } : {}),
      discoverability: event.discoverability as PublicEventDetail['discoverability'],
      accessPolicy: {
        type: accessType,
        ...(event.accessPolicy?.requiresAuthentication ? { requiresAuthentication: true } : {}),
        ...(accessType === EventAccessPolicyType.ACCESS_CODE ? { hasAccessCode: true } : {}),
        ...(accessType === EventAccessPolicyType.EMAIL_DOMAIN
          ? { allowedDomains: event.accessPolicy?.allowedDomains ?? [] }
          : {}),
      },
      admissionModes: event.admissionModes,
      ...(input.organizer?.fullName ? { organizer: { name: input.organizer.fullName } } : {}),
      ...(input.venue ? { venue: this.toPublicVenue(input.venue) } : {}),
      providers: input.providers.map((provider) => this.toPublicProvider(provider)),
      ticketTypes: input.ticketTypes.map((ticket) => this.toPublicTicketType(ticket)),
      relatedEvents: input.relatedEvents
        .filter((related) => Boolean(related.slug && related.startDate))
        .map((related) => this.toPublicRelatedEvent(related)),
      ...((event as Event & { updatedAt?: Date }).updatedAt
        ? { updatedAt: (event as Event & { updatedAt: Date }).updatedAt }
        : {}),
    };
    return detail;
  }

  private toPublicLocation(location: NonNullable<Event['location']>): PublicEventLocation {
    return {
      type: location.type,
      ...(location.name ? { name: location.name } : {}),
      ...(location.address ? { address: location.address } : {}),
      ...(location.city ? { city: location.city } : {}),
      ...(location.province ? { province: location.province } : {}),
      ...(location.postalCode ? { postalCode: location.postalCode } : {}),
    };
  }

  private toPublicVenue(venue: VenueProfile): PublicEventVenue {
    return {
      _id: this.idOf(venue),
      name: venue.name,
      type: venue.type,
      ...(venue.description ? { description: venue.description } : {}),
      address: {
        street: venue.address.street,
        city: venue.address.city,
        ...(venue.address.province ? { province: venue.address.province } : {}),
        ...(venue.address.postalCode ? { postalCode: venue.address.postalCode } : {}),
      },
      capacity: venue.capacity,
      photos: venue.photos ?? [],
      amenities: venue.amenities ?? [],
      rating: venue.rating ?? 0,
      reviewCount: venue.reviewCount ?? 0,
    };
  }

  private toPublicProvider(provider: VendorProfile): PublicEventProvider {
    return {
      _id: this.idOf(provider),
      businessName: provider.businessName,
      category: provider.category,
      ...(provider.description ? { description: provider.description } : {}),
      photos: provider.photos ?? [],
      serviceArea: provider.serviceArea,
      rating: provider.rating ?? 0,
      reviewCount: provider.reviewCount ?? 0,
    };
  }

  private toPublicTicketType(ticket: TicketType): PublicEventTicketType {
    return {
      _id: this.idOf(ticket),
      name: ticket.name,
      price: ticket.price,
      isFree: ticket.isFree,
      quantity: ticket.quantity,
      sold: ticket.sold,
      reserved: ticket.reserved ?? 0,
      ...(ticket.description ? { description: ticket.description } : {}),
    };
  }

  private toPublicRelatedEvent(event: Event): PublicRelatedEvent {
    return {
      _id: this.idOf(event),
      slug: event.slug!,
      title: event.title,
      ...(event.shortDescription ? { shortDescription: event.shortDescription } : {}),
      ...(event.eventType ? { eventType: event.eventType } : {}),
      ...(event.coverImage ? { coverImage: event.coverImage as PublicEventMedia | string } : {}),
      startDate: event.startDate!,
      ...(event.endDate ? { endDate: event.endDate } : {}),
      ...(event.location ? { location: this.toPublicLocation(event.location) } : {}),
    };
  }

  private idOf(value: object): string {
    return String((value as { _id: Types.ObjectId | string })._id);
  }

  async findByOrganizer(
    organizerId: string,
    query: QueryEventDto,
  ): Promise<PaginatedResult<OrganizerEventListItem>> {
    const { page = 1, limit = 12 } = query;
    const filter = this.buildOrganizerFilter(organizerId, query);
    const sort = this.getOrganizerSort(query.sort);

    if (query.view === OrganizerEventView.READY) {
      return this.findReadyByOrganizer(filter, sort, page, limit);
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .select('+accessPolicy.codeHash -__v'),
      this.eventModel.countDocuments(filter),
    ]);
    return {
      data: await this.enrichOrganizerEvents(data as unknown as Event[]),
      total,
      page,
      limit,
    };
  }

  async getOrganizerSummary(organizerId: string): Promise<OrganizerDashboardSummary> {
    const organizer = new Types.ObjectId(organizerId);
    const now = new Date();
    const upcomingEnd = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const visibleFilter = { organizer, archivedAt: null };
    const upcomingFilter = {
      ...visibleFilter,
      status: { $nin: [EventStatus.CANCELLED, EventStatus.COMPLETED] },
      startDate: { $gte: now, $lte: upcomingEnd },
    };

    const [totalEvents, activeEvents, upcomingEvents, draftEvents, upcoming, draftCandidates, requestGroups] = await Promise.all([
      this.eventModel.countDocuments(visibleFilter),
      this.eventModel.countDocuments({
        ...visibleFilter,
        status: { $nin: [EventStatus.CANCELLED, EventStatus.COMPLETED] },
      }),
      this.eventModel.countDocuments(upcomingFilter),
      this.eventModel.countDocuments({ ...visibleFilter, status: EventStatus.DRAFT }),
      this.eventModel
        .find(upcomingFilter)
        .sort({ startDate: 1, _id: 1 })
        .limit(5)
        .lean()
        .select('+accessPolicy.codeHash -__v'),
      this.eventModel
        .find({ ...visibleFilter, status: EventStatus.DRAFT })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(8)
        .lean()
        .select('+accessPolicy.codeHash -__v'),
      this.accessRequestModel.aggregate<{
        _id: Types.ObjectId;
        requestCount: number;
        event: Event;
      }>([
        { $match: { status: EventAccessRequestStatus.PENDING } },
        { $lookup: { from: 'events', localField: 'eventId', foreignField: '_id', as: 'event' } },
        { $unwind: '$event' },
        { $match: { 'event.organizer': organizer, 'event.archivedAt': null } },
        { $group: { _id: '$eventId', requestCount: { $sum: 1 }, event: { $first: '$event' } } },
        { $sort: { requestCount: -1, _id: 1 } },
      ]),
    ]);

    const [safeUpcoming, safeDrafts, safeRequestEvents] = await Promise.all([
      this.enrichOrganizerEvents(upcoming as unknown as Event[]),
      this.enrichOrganizerEvents(draftCandidates as unknown as Event[]),
      this.enrichOrganizerEvents(requestGroups.map((group) => group.event)),
    ]);

    const requestActions = requestGroups.map((group, index): OrganizerDashboardAction => ({
      code: 'REVIEW_ACCESS_REQUESTS',
      priority: 'high',
      event: safeRequestEvents[index],
      progress: this.getProgress(safeRequestEvents[index]),
      requestCount: group.requestCount,
    }));
    const draftActions = safeDrafts.map((event) => this.getDraftAction(event));
    const actions = [...requestActions, ...draftActions]
      .sort((left, right) => this.priorityRank(left.priority) - this.priorityRank(right.priority))
      .slice(0, 4);

    return {
      metrics: {
        totalEvents,
        activeEvents,
        upcomingEvents,
        draftEvents,
        pendingActions: draftEvents + requestGroups.length,
      },
      actions,
      upcoming: safeUpcoming,
      activityAvailable: false,
    };
  }

  async archive(id: string, organizerId: string): Promise<Event> {
    return this.setArchivedAt(id, organizerId, new Date());
  }

  async restore(id: string, organizerId: string): Promise<Event> {
    return this.setArchivedAt(id, organizerId, null);
  }

  private async setArchivedAt(id: string, organizerId: string, archivedAt: Date | null): Promise<Event> {
    const event = await this.eventModel.findById(id).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId: organizerId }, event).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
    const updated = await this.eventModel
      .findByIdAndUpdate(id, { archivedAt }, { new: true, runValidators: true })
      .lean()
      .select('-__v');
    return this.eventAccessService.toSafeEvent(normalizeLegacyEventAccess(updated!));
  }

  private buildOrganizerFilter(organizerId: string, query: QueryEventDto): Record<string, unknown> {
    const filter: Record<string, unknown> = { organizer: new Types.ObjectId(organizerId) };
    const conditions: Record<string, unknown>[] = [];
    const view = query.view ?? OrganizerEventView.ALL;

    filter.archivedAt = view === OrganizerEventView.ARCHIVED ? { $ne: null } : null;
    if (view === OrganizerEventView.DRAFT || view === OrganizerEventView.READY) filter.status = EventStatus.DRAFT;
    if (view === OrganizerEventView.PUBLISHED) filter.status = EventStatus.PUBLISHED;
    if (view === OrganizerEventView.COMPLETED) filter.status = EventStatus.COMPLETED;
    if (query.status) filter.status = query.status;
    if (query.eventType) filter.eventType = query.eventType;
    if (query.discoverability) filter.discoverability = query.discoverability;
    if (query.accessPolicy) filter['accessPolicy.type'] = query.accessPolicy;

    if (query.search) {
      const expression = { $regex: escapeRegExp(query.search), $options: 'i' };
      conditions.push({
        $or: [
          { title: expression },
          { eventType: expression },
          { 'location.name': expression },
          { 'location.city': expression },
        ],
      });
    }
    if (query.progress) {
      const size = { $size: { $ifNull: ['$creationProgress.completedSteps', []] } };
      conditions.push({ $expr: query.progress === OrganizerEventProgress.COMPLETE ? { $gte: [size, 6] } : { $lt: [size, 6] } });
    }
    if (query.date === OrganizerEventDate.UPCOMING) filter.startDate = { $gte: new Date() };
    if (query.date === OrganizerEventDate.PAST) filter.startDate = { $lt: new Date() };
    if (query.date === OrganizerEventDate.UNDATED) conditions.push({ $or: [{ startDate: null }, { startDate: { $exists: false } }] });
    if (conditions.length) filter.$and = conditions;
    return filter;
  }

  private getOrganizerSort(sort = OrganizerEventSort.UPDATED_DESC): Record<string, 1 | -1> {
    if (sort === OrganizerEventSort.DATE_ASC) return { startDate: 1, _id: 1 };
    if (sort === OrganizerEventSort.TITLE_ASC) return { title: 1, _id: 1 };
    return { updatedAt: -1, _id: -1 };
  }

  private async findReadyByOrganizer(
    filter: Record<string, unknown>,
    sort: Record<string, 1 | -1>,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<OrganizerEventListItem>> {
    const start = (page - 1) * limit;
    const end = start + limit;
    const data: OrganizerEventListItem[] = [];
    let total = 0;
    let offset = 0;

    while (true) {
      const candidates = await this.eventModel
        .find(filter)
        .sort(sort)
        .skip(offset)
        .limit(ORGANIZER_SCAN_BATCH_SIZE)
        .lean()
        .select('+accessPolicy.codeHash -__v');
      if (candidates.length === 0) break;
      const enriched = await this.enrichOrganizerEvents(candidates as unknown as Event[]);
      for (const event of enriched) {
        if (!event.readiness.publishable) continue;
        if (total >= start && total < end) data.push(event);
        total += 1;
      }
      offset += candidates.length;
      if (candidates.length < ORGANIZER_SCAN_BATCH_SIZE) break;
    }

    return { data, total, page, limit };
  }

  private async enrichOrganizerEvents(events: Event[]): Promise<OrganizerEventListItem[]> {
    if (events.length === 0) return [];
    const ids = events.map((event) => (event as Event & { _id: Types.ObjectId })._id);
    const [ticketGroups, requestGroups] = await Promise.all([
      this.ticketTypeModel.aggregate<{
        _id: Types.ObjectId;
        freeTicketTypes: number;
        paidTicketTypes: number;
      }>([
        { $match: { event: { $in: ids } } },
        {
          $group: {
            _id: '$event',
            freeTicketTypes: { $sum: { $cond: ['$isFree', 1, 0] } },
            paidTicketTypes: { $sum: { $cond: ['$isFree', 0, 1] } },
          },
        },
      ]),
      this.accessRequestModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { eventId: { $in: ids }, status: EventAccessRequestStatus.PENDING } },
        { $group: { _id: '$eventId', count: { $sum: 1 } } },
      ]),
    ]);
    const inventory = new Map(ticketGroups.map((group) => [group._id.toString(), group]));
    const requests = new Map(requestGroups.map((group) => [group._id.toString(), group.count]));

    return events.map((event) => {
      const normalized = normalizeLegacyEventAccess(event);
      const id = (normalized as Event & { _id: Types.ObjectId })._id.toString();
      const counts = inventory.get(id) ?? { freeTicketTypes: 0, paidTicketTypes: 0 };
      const readiness = validateEventPublishability(normalized, counts);
      const safe = this.eventAccessService.toSafeEvent(normalized) as OrganizerEventListItem;
      return { ...safe, readiness, pendingAccessRequests: requests.get(id) ?? 0 };
    });
  }

  private getDraftAction(event: OrganizerEventListItem): OrganizerDashboardAction {
    const error = event.readiness.errors[0]?.code;
    let code: OrganizerActionCode = 'CONTINUE_CREATION';
    let priority: OrganizerDashboardAction['priority'] = 'medium';

    if (['TITLE_REQUIRED', 'EVENT_TYPE_REQUIRED'].includes(error)) code = 'COMPLETE_INFORMATION';
    else if (['START_DATE_REQUIRED', 'END_BEFORE_START'].includes(error)) code = 'COMPLETE_SCHEDULE';
    else if (error === 'PHYSICAL_LOCATION_REQUIRED') code = 'ADD_VENUE';
    else if (error?.includes('TICKET_TYPE')) code = 'CONFIGURE_TICKETS';
    else if (error) code = 'CONFIGURE_ACCESS';
    else if (!event.coverImage) code = 'ADD_COVER';
    else if (event.readiness.publishable) {
      code = 'PUBLISH_EVENT';
      priority = 'high';
    }
    return { code, priority, event, progress: this.getProgress(event) };
  }

  private getProgress(event: Event): number {
    const completed = new Set(event.creationProgress?.completedSteps ?? []).size;
    return Math.round((Math.min(completed, 6) / 6) * 100);
  }

  private priorityRank(priority: OrganizerDashboardAction['priority']): number {
    return priority === 'high' ? 0 : priority === 'medium' ? 1 : 2;
  }
}
