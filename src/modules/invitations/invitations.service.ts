import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { FlattenMaps, Model, Types } from 'mongoose';
import { Invitation, InvitationDocument, InvitationStatus } from './invitation.schema';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { EmailsService } from '../emails/emails.service';
import { User, UserDocument } from '../auth/user.schema';

@Injectable()
export class InvitationsService {
  constructor(
    @InjectModel(Invitation.name)
    private readonly invitationModel: Model<InvitationDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
  ) {}

  async sendInvitation(
    invitedById: string,
    dto: CreateInvitationDto,
  ): Promise<InvitationDocument> {
    let invitation: InvitationDocument;
    try {
      invitation = await this.invitationModel.create({
        invitedBy: new Types.ObjectId(invitedById),
        email: dto.email,
        name: dto.name,
        type: dto.type,
        category: dto.category,
        eventId: dto.eventId ? new Types.ObjectId(dto.eventId) : null,
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
    const invitationLink = `${frontendUrl}/invitation?token=${invitation.token}`;

    this.emailsService
      .sendInvitationEmail(dto.email, {
        inviterName: inviter?.fullName ?? 'Un organisateur',
        type: dto.type as 'vendor' | 'venue',
        invitationLink,
      })
      .catch(() => undefined);

    return invitation;
  }

  async getMyInvitations(
    invitedById: string,
  ): Promise<FlattenMaps<InvitationDocument>[]> {
    return this.invitationModel
      .find({ invitedBy: new Types.ObjectId(invitedById) })
      .lean()
      .exec();
  }

  async acceptInvitation(token: string): Promise<InvitationDocument> {
    const invitation = await this.invitationModel
      .findOne({ token, status: InvitationStatus.PENDING })
      .exec();

    if (!invitation) {
      throw new NotFoundException(ErrorCodes.INVITATION_NOT_FOUND);
    }

    if (invitation.expiresAt < new Date()) {
      invitation.status = InvitationStatus.EXPIRED;
      await invitation.save();
      throw new NotFoundException(ErrorCodes.INVITATION_EXPIRED);
    }

    invitation.status = InvitationStatus.ACCEPTED;
    invitation.acceptedAt = new Date();
    return invitation.save();
  }

  async markConverted(token: string, userId: string): Promise<void> {
    await this.invitationModel
      .findOneAndUpdate(
        { token },
        { convertedUserId: new Types.ObjectId(userId) },
      )
      .exec();
  }
}
