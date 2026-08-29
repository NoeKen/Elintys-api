import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  EventRegistration,
  EventRegistrationDocument,
  EventRegistrationStatus,
} from './event-registration.schema';
import { RegisterEventDto } from './dto/register-event.dto';
import { IdempotencyService } from '../../shared/consistency/idempotency/idempotency.service';
import {
  RegistrationAlreadyExistsError,
  translateMongoE11000,
} from '../../shared/consistency/errors/consistency.errors';
import { Event, AdmissionMode, EventDocument, EventStatus } from '../events/event.schema';
import {
  EventAccessService,
} from '../events/event-access.service';
import {
  canRegisterForEvent,
  normalizeLegacyEventAccess,
} from '../events/event-access.policy';
import { QueryEventRegistrationsDto } from './dto/query-event-registrations.dto';

export interface EventRegistrationResult {
  _id: string;
  eventId: string;
  status: EventRegistrationStatus;
}

export interface PaginatedEventRegistrations {
  data: EventRegistration[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class EventRegistrationService {
  constructor(
    @InjectModel(EventRegistration.name)
    private readonly registrationModel: Model<EventRegistrationDocument>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    private readonly idempotencyService: IdempotencyService,
    private readonly eventAccessService: EventAccessService,
  ) {}

  async register(
    participantId: string,
    dto: RegisterEventDto,
    idempotencyKey: string,
    accessGrant?: string,
  ): Promise<EventRegistrationResult> {
    return this.idempotencyService.execute<EventRegistrationResult>({
      scope: 'event-registration',
      actorId: participantId,
      idempotencyKey,
      payload: { eventId: dto.eventId },
      operation: async (session: ClientSession) => {
        const event = await this.eventModel
          .findById(dto.eventId)
          .session(session)
          .lean()
          .select('status archivedAt admissionModes accessPolicy discoverability organizer accessModelVersion');

        if (!event || event.status !== EventStatus.PUBLISHED || event.archivedAt) {
          throw new NotFoundException('Événement introuvable.');
        }

        if (!(event.admissionModes ?? []).includes(AdmissionMode.REGISTRATION_ONLY)) {
          throw new BadRequestException('REGISTRATION_NOT_AVAILABLE');
        }

        const actor = await this.eventAccessService.buildActor(
          participantId,
          dto.eventId,
          accessGrant,
          session,
        );
        const decision = canRegisterForEvent(actor, normalizeLegacyEventAccess(event));
        if (!decision.allowed) throw new ForbiddenException(decision.reason);

        try {
          const [reg] = await this.registrationModel.create(
            [
              {
                eventId: new Types.ObjectId(dto.eventId),
                participantId: new Types.ObjectId(participantId),
                status: EventRegistrationStatus.ACTIVE,
              },
            ],
            { session },
          );
          return {
            _id: String((reg as EventRegistrationDocument & { _id: Types.ObjectId })._id),
            eventId: dto.eventId,
            status: EventRegistrationStatus.ACTIVE,
          };
        } catch (err: unknown) {
          throw translateMongoE11000(
            err,
            {
              'eventId,participantId': new RegistrationAlreadyExistsError(),
            },
          );
        }
      },
      toReplayResult: (result) => result,
    });
  }

  async cancel(registrationId: string, participantId: string): Promise<void> {
    const reg = await this.registrationModel
      .findById(registrationId)
      .lean()
      .select('participantId status');

    if (!reg) throw new NotFoundException('Inscription introuvable.');
    if (reg.participantId?.toString() !== participantId) {
      throw new ForbiddenException('Accès refusé.');
    }
    if (reg.status === EventRegistrationStatus.CANCELLED) return;

    await this.registrationModel.findByIdAndUpdate(registrationId, {
      status: EventRegistrationStatus.CANCELLED,
    });
  }

  async findByEvent(
    eventId: string,
    organizerId: string,
    query: QueryEventRegistrationsDto = {},
  ): Promise<PaginatedEventRegistrations> {
    const event = await this.eventModel
      .findById(eventId)
      .lean()
      .select('organizer');

    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException('Accès refusé.');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const filter = {
      eventId: new Types.ObjectId(eventId),
      status: EventRegistrationStatus.ACTIVE,
    };
    const [data, total] = await Promise.all([
      this.registrationModel
        .find(filter)
        .lean()
        .select('-__v')
        .populate('participantId', 'fullName email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.registrationModel.countDocuments(filter),
    ]);
    return { data: data as unknown as EventRegistration[], total, page, limit };
  }

  async findMine(
    participantId: string,
    query: QueryEventRegistrationsDto = {},
  ): Promise<PaginatedEventRegistrations> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const filter = {
      participantId: new Types.ObjectId(participantId),
      status: EventRegistrationStatus.ACTIVE,
    };
    const [data, total] = await Promise.all([
      this.registrationModel
        .find(filter)
        .lean()
        .select('-__v')
        .populate('eventId', 'title slug startDate endDate coverImage status')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.registrationModel.countDocuments(filter),
    ]);
    return { data: data as unknown as EventRegistration[], total, page, limit };
  }
}
