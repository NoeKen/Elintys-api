import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FlattenMaps, Model, Types } from 'mongoose';
import { Invitation, InvitationDocument, InvitationStatus } from './invitation.schema';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { ErrorCodes } from '../../shared/constants/error-codes';

@Injectable()
export class InvitationsService {
  constructor(
    @InjectModel(Invitation.name)
    private readonly invitationModel: Model<InvitationDocument>,
  ) {}

  async sendInvitation(
    invitedById: string,
    dto: CreateInvitationDto,
  ): Promise<InvitationDocument> {
    try {
      return await this.invitationModel.create({
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
