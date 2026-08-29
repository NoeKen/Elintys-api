import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { FlattenMaps, Model, Types } from 'mongoose';
import { Invitation, InvitationDocument, InvitationStatus, InvitationType } from './invitation.schema';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EmailsService } from '../emails/emails.service';
import { User, UserDocument } from '../auth/user.schema';
import { createHash, randomBytes } from 'crypto';
import { AdmissionMode, Event, EventDocument, EventStatus } from '../events/event.schema';
import { canManageEvent } from '../events/event-access.policy';
import { QueryEventInvitationsDto } from './dto/query-event-invitations.dto';

export interface OrganizerInvitationDto {
  _id: string;
  email: string;
  name: string;
  type: string;
  status: string;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdAt: string;
}

export interface PaginatedOrganizerInvitationsDto {
  data: OrganizerInvitationDto[];
  total: number;
  page: number;
  limit: number;
}

export interface ReceivedInvitationDto extends OrganizerInvitationDto {
  event?: {
    _id: string;
    title: string;
    slug: string;
    startDate?: string;
  };
}

export interface PaginatedReceivedInvitationsDto {
  data: ReceivedInvitationDto[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    @InjectModel(Invitation.name)
    private readonly invitationModel: Model<InvitationDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
  ) {}

  async sendInvitation(
    invitedById: string,
    dto: CreateInvitationDto,
  ): Promise<Record<string, unknown>> {
    if (dto.type === InvitationType.PARTICIPANT && !dto.eventId) {
      throw new ConflictException('PARTICIPANT_INVITATION_REQUIRES_EVENT');
    }
    if (dto.eventId) {
      const event = await this.eventModel.findById(dto.eventId).lean().select('organizer status admissionModes');
      if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
      if (!canManageEvent({ userId: invitedById }, event).allowed) {
        throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
      }
      if ([EventStatus.CANCELLED, EventStatus.COMPLETED].includes(event.status)) {
        throw new ConflictException('EVENT_DOES_NOT_ACCEPT_INVITATIONS');
      }
      if (dto.type === InvitationType.PARTICIPANT && !event.admissionModes?.includes(AdmissionMode.INVITATION)) {
        throw new ConflictException('INVITATION_ADMISSION_DISABLED');
      }
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    let invitation: InvitationDocument;
    try {
      invitation = await this.invitationModel.create({
        invitedBy: new Types.ObjectId(invitedById),
        email: dto.email,
        name: dto.name,
        type: dto.type,
        category: dto.category,
        eventId: dto.eventId ? new Types.ObjectId(dto.eventId) : null,
        tokenHash,
        tokenPrefix: rawToken.slice(0, 8),
      });
    } catch (error: unknown) {
      throw this.translateDuplicateKeyError(error);
    }

    const inviter = await this.userModel
      .findById(invitedById)
      .lean()
      .select('fullName');
    const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');
    const invitationLink = `${frontendUrl}/invitation?token=${rawToken}`;

    this.emailsService
      .sendInvitationEmail(dto.email, {
        inviterName: inviter?.fullName ?? 'Un organisateur',
        type: dto.type as 'vendor' | 'venue',
        invitationLink,
      })
      .catch(() => undefined);

    const serialized = typeof invitation.toObject === 'function'
      ? invitation.toObject()
      : invitation;
    return this.toSafeInvitation(serialized as unknown as Record<string, unknown>);
  }

  async getMyInvitations(
    invitedById: string,
  ): Promise<FlattenMaps<InvitationDocument>[]> {
    return this.invitationModel
      .find({ invitedBy: new Types.ObjectId(invitedById) })
      .lean()
      .select('-token -tokenHash -tokenPrefix')
      .exec();
  }

  async acceptInvitation(token: string): Promise<Record<string, unknown>> {
    const invitation = await this.invitationModel
      .findOneAndUpdate(
        {
          tokenHash: this.hashToken(token),
          status: InvitationStatus.PENDING,
          expiresAt: { $gt: new Date() },
          $expr: { $lt: ['$useCount', '$maxUses'] },
        },
        {
          $inc: { useCount: 1 },
          $set: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date() },
        },
        { new: true },
      )
      .exec();

    if (!invitation) {
      throw new NotFoundException(ErrorCodes.INVITATION_NOT_FOUND);
    }
    const serialized = typeof invitation.toObject === 'function'
      ? invitation.toObject()
      : invitation;
    return this.toSafeInvitation(serialized as unknown as Record<string, unknown>);
  }

  async markConverted(token: string, userId: string): Promise<void> {
    await this.invitationModel
      .findOneAndUpdate(
        { tokenHash: this.hashToken(token) },
        { convertedUserId: new Types.ObjectId(userId) },
      )
      .exec();
  }

  async findByEvent(
    eventId: string,
    requesterId: string,
    requesterRoles: string[] = [],
    query: QueryEventInvitationsDto = {},
  ): Promise<PaginatedOrganizerInvitationsDto> {
    if (!Types.ObjectId.isValid(eventId) || !/^[0-9a-fA-F]{24}$/.test(eventId)) {
      throw new BadRequestException('INVALID_OBJECT_ID');
    }

    const event = await this.eventModel
      .findById(eventId)
      .lean()
      .select('organizer');

    if (!event) {
      throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    }

    if (!canManageEvent({ userId: requesterId, roles: requesterRoles }, event).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const filter = { eventId: new Types.ObjectId(eventId), type: InvitationType.PARTICIPANT };
    const [invitations, total] = await Promise.all([
      this.invitationModel
        .find(filter)
        .lean()
        .select('-tokenHash -token -tokenPrefix -__v')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.invitationModel.countDocuments(filter),
    ]);

    const data = invitations.map((inv) => ({
      _id: String(inv._id),
      email: inv.email,
      name: inv.name,
      type: inv.type,
      status: inv.status,
      maxUses: inv.maxUses,
      useCount: inv.useCount,
      expiresAt: inv.expiresAt instanceof Date ? inv.expiresAt.toISOString() : String(inv.expiresAt),
      createdAt: (inv as unknown as { createdAt: Date }).createdAt instanceof Date
        ? (inv as unknown as { createdAt: Date }).createdAt.toISOString()
        : String((inv as unknown as { createdAt: unknown }).createdAt),
    }));

    return { data, total, page, limit };
  }

  async findReceived(
    userId: string,
    options: { page: number; limit: number },
  ): Promise<PaginatedReceivedInvitationsDto> {
    const user = await this.userModel.findById(userId).lean().select('email isEmailVerified');
    if (!user?.isEmailVerified) throw new ForbiddenException('VERIFIED_EMAIL_REQUIRED');

    const filter = { email: user.email.toLowerCase(), type: InvitationType.PARTICIPANT };
    const [invitations, total] = await Promise.all([
      this.invitationModel
        .find(filter)
        .lean()
        .select('-tokenHash -token -tokenPrefix -__v')
        .populate('eventId', 'title slug startDate')
        .sort({ createdAt: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .exec(),
      this.invitationModel.countDocuments(filter),
    ]);

    const data = invitations.map((inv) => {
      const event = inv.eventId && typeof inv.eventId === 'object'
        ? inv.eventId as unknown as { _id: Types.ObjectId; title: string; slug: string; startDate?: Date }
        : undefined;
      return {
        _id: String(inv._id),
        email: inv.email,
        name: inv.name,
        type: inv.type,
        status: inv.status,
        maxUses: inv.maxUses,
        useCount: inv.useCount,
        expiresAt: inv.expiresAt instanceof Date ? inv.expiresAt.toISOString() : String(inv.expiresAt),
        createdAt: (inv as unknown as { createdAt: Date }).createdAt instanceof Date
          ? (inv as unknown as { createdAt: Date }).createdAt.toISOString()
          : String((inv as unknown as { createdAt: unknown }).createdAt),
        ...(event ? {
          event: {
            _id: String(event._id),
            title: event.title,
            slug: event.slug,
            ...(event.startDate ? { startDate: event.startDate.toISOString() } : {}),
          },
        } : {}),
      };
    });

    return { data, total, page: options.page, limit: options.limit };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Traduit une erreur de clé dupliquée MongoDB (finding F-028).
   *
   * L'ancienne implémentation transformait **toute** collision E11000 en
   * `INVITATION_ALREADY_SENT`, ce qui masquait les défauts techniques derrière un
   * message métier trompeur. On distingue désormais l'index en cause via
   * `keyPattern`, et aucune valeur d'erreur Mongo (donc aucun jeton) n'est propagée.
   */
  private translateDuplicateKeyError(error: unknown): Error {
    const mongoError = error as {
      code?: number;
      keyPattern?: Record<string, unknown>;
      message?: string;
    };
    if (mongoError?.code !== 11000) {
      return error as Error;
    }

    const keys = Object.keys(mongoError.keyPattern ?? {});
    const isBusinessDuplicate =
      keys.includes('invitedBy') && keys.includes('email');

    if (isBusinessDuplicate) {
      return new ConflictException(ErrorCodes.INVITATION_ALREADY_SENT);
    }

    // Collision technique (tokenHash, ou tout autre index) : jamais présentée comme
    // un doublon métier. On journalise l'index en cause — jamais la valeur.
    this.logger.error(
      `INVITATION_PERSISTENCE_CONFLICT sur l'index [${keys.join(',') || 'inconnu'}]`,
    );
    return new InternalServerErrorException(
      "Impossible d'enregistrer l'invitation. Veuillez réessayer.",
    );
  }

  private toSafeInvitation(invitation: Record<string, unknown>): Record<string, unknown> {
    const { token: _legacy, tokenHash: _hash, tokenPrefix: _prefix, ...safe } = invitation;
    return safe;
  }
}
