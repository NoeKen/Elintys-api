import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { randomUUID } from 'crypto';

export type InvitationDocument = HydratedDocument<Invitation>;

export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  EXPIRED = 'expired',
}

export enum InvitationType {
  VENDOR = 'vendor',
  VENUE = 'venue',
}

@Schema({ timestamps: true })
export class Invitation {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  invitedBy!: Types.ObjectId;

  @Prop({ type: String, required: true, lowercase: true, trim: true, maxlength: 255 })
  email!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  name!: string;

  @Prop({ type: String, enum: Object.values(InvitationType), required: true })
  type!: InvitationType;

  @Prop({ type: String, maxlength: 50 })
  category?: string;

  @Prop({ type: Types.ObjectId, ref: 'Event', default: null })
  eventId?: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(InvitationStatus),
    default: InvitationStatus.PENDING,
  })
  status!: InvitationStatus;

  @Prop({
    type: String,
    default: () => randomUUID(),
  })
  token!: string;

  @Prop({ type: Date, default: null })
  acceptedAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  convertedUserId?: Types.ObjectId | null;

  @Prop({
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })
  expiresAt!: Date;
}

export const InvitationSchema = SchemaFactory.createForClass(Invitation);

InvitationSchema.index({ invitedBy: 1, email: 1 }, { unique: true });
InvitationSchema.index({ token: 1 }, { unique: true });
InvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
