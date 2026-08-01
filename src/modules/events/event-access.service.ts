import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../auth/user.schema';
import { Guest, GuestDocument } from '../guests/guest.schema';
import {
  Invitation,
  InvitationDocument,
  InvitationStatus,
  InvitationType,
} from '../invitations/invitation.schema';
import {
  EventAccessRequest,
  EventAccessRequestDocument,
  EventAccessRequestStatus,
} from './event-access-request.schema';
import {
  canManageEvent,
  canRegisterForEvent,
  canViewEvent,
  EventActor,
  isAllowedEmailDomain,
  normalizeLegacyEventAccess,
  validateEventAccessConfiguration,
} from './event-access.policy';
import {
  Event,
  EventAccessPolicy,
  EventAccessPolicyType,
  EventDocument,
  EventStatus,
} from './event.schema';
import { EventAccessPolicyDto } from './dto/create-event.dto';
import { UpdateEventAccessConfigurationDto } from './dto/update-event-access-configuration.dto';

type AccessGrantPayload = { sub: string; eventId: string; purpose: 'event-access' };

@Injectable()
export class EventAccessService {
  private readonly logger = new Logger(EventAccessService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(EventAccessRequest.name) private readonly requestModel: Model<EventAccessRequestDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Guest.name) private readonly guestModel: Model<GuestDocument>,
    @InjectModel(Invitation.name) private readonly invitationModel: Model<InvitationDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async preparePolicy(policy: EventAccessPolicyDto, existingCodeHash?: string): Promise<EventAccessPolicy> {
    const allowedDomains = policy.allowedDomains?.map((domain) => domain.trim().toLowerCase().replace(/^@/, ''));
    const allowedKeys: Record<EventAccessPolicyType, Array<keyof EventAccessPolicyDto>> = {
      open: ['type'],
      registration_required: ['type', 'requiresAuthentication'],
      access_code: ['type', 'code'],
      email_domain: ['type', 'requiresAuthentication', 'allowedDomains'],
      manual_approval: ['type', 'requiresAuthentication'],
      guest_list: ['type', 'requiresAuthentication'],
      invitation_token: ['type'],
    };
    const supplied = (Object.keys(policy) as Array<keyof EventAccessPolicyDto>).filter(
      (key) => key !== 'type' && policy[key] !== undefined,
    );
    const irrelevant = supplied.filter((key) => !allowedKeys[policy.type].includes(key));
    if (irrelevant.length > 0) throw new BadRequestException(`ACCESS_POLICY_FIELDS_NOT_ALLOWED:${irrelevant.join(',')}`);

    const prepared: EventAccessPolicy = {
      type: policy.type,
      requiresAuthentication: policy.requiresAuthentication,
      allowedDomains,
    };
    if (policy.type === EventAccessPolicyType.ACCESS_CODE) {
      if (policy.code) prepared.codeHash = await bcrypt.hash(policy.code, 12);
      else if (existingCodeHash) prepared.codeHash = existingCodeHash;
    }
    return prepared;
  }

  async updateConfiguration(
    eventId: string,
    actor: EventActor,
    dto: UpdateEventAccessConfigurationDto,
  ): Promise<Event> {
    const event = await this.eventModel.findById(eventId).select('+accessPolicy.codeHash').exec();
    if (!event) throw new NotFoundException('EVENT_NOT_FOUND');
    if (!canManageEvent(actor, event).allowed) throw new ForbiddenException('EVENT_NOT_OWNER');

    const prepared = await this.preparePolicy(dto.accessPolicy, event.accessPolicy?.codeHash);
    const candidate = {
      ...event.toObject(),
      discoverability: dto.discoverability,
      accessPolicy: prepared,
      admissionModes: dto.admissionModes,
    };
    const validation = validateEventAccessConfiguration(candidate);
    if (!validation.valid) throw new BadRequestException(validation.errors);

    event.discoverability = dto.discoverability;
    event.accessPolicy = prepared;
    event.admissionModes = dto.admissionModes;
    event.accessModelVersion = 2;
    await event.save();
    return this.toSafeEvent(event.toObject());
  }

  async verifyCode(eventId: string, code: string, requestId?: string): Promise<{ authorized: true; accessGrant: string }> {
    const event = await this.eventModel
      .findOne({ _id: eventId, status: EventStatus.PUBLISHED })
      .select('+accessPolicy.codeHash accessPolicy.type')
      .exec();
    const hash = event?.accessPolicy?.codeHash;
    const valid = Boolean(
      event &&
      event.accessPolicy?.type === EventAccessPolicyType.ACCESS_CODE &&
      hash &&
      (await bcrypt.compare(code, hash)),
    );
    if (!valid || !event) {
      this.logDecision(eventId, 'access_code', 'denied', 'ACCESS_CODE_INVALID', requestId);
      throw new ForbiddenException('ACCESS_CODE_INVALID');
    }
    const secret = this.configService.getOrThrow<string>('jwt.secret');
    const accessGrant = await this.jwtService.signAsync(
      { sub: 'event-access', eventId, purpose: 'event-access' } satisfies AccessGrantPayload,
      { secret, expiresIn: '15m', audience: 'elintys-event-access' },
    );
    this.logDecision(eventId, 'access_code', 'allowed', 'ACCESS_CODE_VALID', requestId);
    return { authorized: true, accessGrant };
  }

  async resolveAccessGrant(token: string): Promise<Event> {
    try {
      const secret = this.configService.getOrThrow<string>('jwt.secret');
      const payload = await this.jwtService.verifyAsync<AccessGrantPayload>(token, {
        secret,
        audience: 'elintys-event-access',
      });
      if (payload.purpose !== 'event-access') throw new Error('invalid purpose');
      const event = await this.eventModel.findById(payload.eventId).lean().select('-__v -accessPolicy.codeHash');
      if (!event) throw new NotFoundException('EVENT_NOT_FOUND');
      return this.toPublicEvent(event);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException('EVENT_ACCESS_GRANT_INVALID');
    }
  }

  async checkDomain(eventId: string, userId: string, requestId?: string): Promise<{ authorized: boolean; reason: string }> {
    const [event, user] = await Promise.all([
      this.eventModel.findById(eventId).lean().select('accessPolicy status'),
      this.userModel.findById(userId).lean().select('email isEmailVerified'),
    ]);
    if (!event || event.status !== EventStatus.PUBLISHED) throw new NotFoundException('EVENT_NOT_FOUND');
    if (event.accessPolicy?.type !== EventAccessPolicyType.EMAIL_DOMAIN) throw new BadRequestException('EMAIL_DOMAIN_POLICY_NOT_ACTIVE');
    if (!user?.isEmailVerified) {
      this.logDecision(eventId, 'email_domain', 'denied', 'VERIFIED_EMAIL_REQUIRED', requestId);
      return { authorized: false, reason: 'VERIFIED_EMAIL_REQUIRED' };
    }
    const authorized = isAllowedEmailDomain(user.email, event.accessPolicy.allowedDomains ?? []);
    const reason = authorized ? 'EMAIL_DOMAIN_ALLOWED' : 'EMAIL_DOMAIN_NOT_ALLOWED';
    this.logDecision(eventId, 'email_domain', authorized ? 'allowed' : 'denied', reason, requestId);
    return { authorized, reason };
  }

  async findAuthorizedEvent(eventId: string, userId: string, accessGrant?: string, requestId?: string): Promise<Event> {
    const event = await this.eventModel
      .findOne({ _id: eventId, status: EventStatus.PUBLISHED })
      .lean()
      .select('-__v -accessPolicy.codeHash');
    if (!event) throw new NotFoundException('EVENT_NOT_FOUND');
    const normalized = normalizeLegacyEventAccess(event);
    const actor = await this.buildActor(userId, eventId, accessGrant);
    const decision = canViewEvent(actor, normalized);
    this.logDecision(eventId, normalized.accessPolicy.type, decision.allowed ? 'allowed' : 'denied', decision.reason, requestId);
    if (!decision.allowed) {
      throw new NotFoundException('EVENT_NOT_FOUND');
    }
    return this.toPublicEvent(normalized);
  }

  async requestAccess(eventId: string, userId: string, requestId?: string): Promise<EventAccessRequest> {
    const event = await this.eventModel.findById(eventId).lean().select('accessPolicy status');
    if (!event || event.status !== EventStatus.PUBLISHED) throw new NotFoundException('EVENT_NOT_FOUND');
    if (event.accessPolicy?.type !== EventAccessPolicyType.MANUAL_APPROVAL) throw new BadRequestException('MANUAL_APPROVAL_NOT_ACTIVE');
    try {
      const request = await this.requestModel.create({ eventId: new Types.ObjectId(eventId), userId: new Types.ObjectId(userId) });
      this.logDecision(eventId, 'manual_approval', 'pending', 'ACCESS_REQUEST_CREATED', requestId);
      return request.toObject();
    } catch (error: unknown) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('ACCESS_REQUEST_ALREADY_EXISTS');
      throw error;
    }
  }

  async listRequests(eventId: string, actor: EventActor): Promise<EventAccessRequest[]> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException('EVENT_NOT_FOUND');
    if (!canManageEvent(actor, event).allowed) throw new ForbiddenException('EVENT_NOT_OWNER');
    return this.requestModel.find({ eventId: new Types.ObjectId(eventId) }).lean().select('-__v');
  }

  async reviewRequest(
    eventId: string,
    requestId: string,
    actor: EventActor,
    status: EventAccessRequestStatus.APPROVED | EventAccessRequestStatus.REJECTED,
  ): Promise<EventAccessRequest> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException('EVENT_NOT_FOUND');
    if (!canManageEvent(actor, event).allowed) throw new ForbiddenException('EVENT_NOT_OWNER');
    const updated = await this.requestModel.findOneAndUpdate(
      { _id: requestId, eventId: new Types.ObjectId(eventId) },
      { status, reviewedAt: new Date(), reviewedBy: new Types.ObjectId(actor.userId!) },
      { new: true },
    ).lean().select('-__v');
    if (!updated) throw new NotFoundException('ACCESS_REQUEST_NOT_FOUND');
    return updated;
  }

  async buildActor(userId: string, eventId: string, accessGrant?: string): Promise<EventActor> {
    const user = await this.userModel.findById(userId).lean().select('email isEmailVerified roles');
    const [request, guest, invitation] = await Promise.all([
      this.requestModel.findOne({ eventId: new Types.ObjectId(eventId), userId: new Types.ObjectId(userId), status: EventAccessRequestStatus.APPROVED }).lean().select('_id'),
      user?.email
        ? this.guestModel.findOne({ event: new Types.ObjectId(eventId), email: user.email.toLowerCase() }).lean().select('_id')
        : null,
      user?.email
        ? this.invitationModel.findOne({
            eventId: new Types.ObjectId(eventId),
            email: user.email.toLowerCase(),
            type: InvitationType.PARTICIPANT,
            status: InvitationStatus.ACCEPTED,
            expiresAt: { $gt: new Date() },
          }).lean().select('_id')
        : null,
    ]);
    let accessGrantValid = false;
    if (accessGrant) {
      try {
        const resolved = await this.resolveAccessGrant(accessGrant);
        accessGrantValid = String((resolved as Event & { _id: unknown })._id) === eventId;
      } catch { accessGrantValid = false; }
    }
    return {
      userId,
      email: user?.email,
      isEmailVerified: user?.isEmailVerified,
      roles: user?.roles,
      accessGrant: accessGrantValid,
      hasApprovedRequest: Boolean(request),
      isOnGuestList: Boolean(guest),
      hasInvitation: Boolean(invitation),
    };
  }

  assertRegistrationAllowed(actor: EventActor, event: Event): void {
    const decision = canRegisterForEvent(actor, event);
    if (!decision.allowed) throw new ForbiddenException(decision.reason);
  }

  toSafeEvent<T extends Record<string, unknown> | Event>(event: T): T {
    const copy = { ...event } as T & { accessPolicy?: Record<string, unknown>; accessRules?: unknown };
    if (copy.accessPolicy) {
      const { codeHash: _secret, ...safe } = copy.accessPolicy;
      copy.accessPolicy = {
        ...safe,
        ...(safe.type === EventAccessPolicyType.ACCESS_CODE ? { hasAccessCode: true } : {}),
      };
    }
    return copy;
  }

  toPublicEvent<T extends Record<string, unknown> | Event>(event: T): T {
    const copy = this.toSafeEvent(event) as T & {
      accessPolicy?: Record<string, unknown>;
      organizer?: unknown;
      vendors?: unknown;
      creationProgress?: unknown;
      accessRules?: unknown;
      visibility?: unknown;
    };
    if (copy.accessPolicy) {
      copy.accessPolicy = {
        type: copy.accessPolicy.type,
        ...(copy.accessPolicy.type === EventAccessPolicyType.ACCESS_CODE ? { hasAccessCode: true } : {}),
      };
    }
    delete copy.organizer;
    delete copy.vendors;
    delete copy.creationProgress;
    delete copy.accessRules;
    delete copy.visibility;
    return copy;
  }

  private logDecision(eventId: string, policy: string, decision: string, reason: string, requestId?: string): void {
    this.logger.warn(JSON.stringify({ event: 'EVENT_ACCESS_DECISION', eventId, policy, decision, reason, requestId }));
  }
}
