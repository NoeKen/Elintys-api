import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class InvitationsService {
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
      const mongoError = error as { code?: number };
      if (mongoError?.code === 11000) {
        throw new ConflictException(ErrorCodes.INVITATION_ALREADY_SENT);
      }
      throw error;
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
      .select('-token -tokenHash')
      .exec();
  }

  async acceptInvitation(token: string): Promise<InvitationDocument> {
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
    return invitation;
  }

  async markConverted(token: string, userId: string): Promise<void> {
    await this.invitationModel
      .findOneAndUpdate(
        { tokenHash: this.hashToken(token) },
        { convertedUserId: new Types.ObjectId(userId) },
      )
      .exec();
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toSafeInvitation(invitation: Record<string, unknown>): Record<string, unknown> {
    const { token: _legacy, tokenHash: _hash, ...safe } = invitation;
    return safe;
  }
}
