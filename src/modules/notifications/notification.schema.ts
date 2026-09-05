import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotificationDocument = HydratedDocument<Notification>;

export enum NotificationType {
  VENDOR_RESPONDED = 'VENDOR_RESPONDED',
  VENDOR_REQUEST_RECEIVED = 'VENDOR_REQUEST_RECEIVED',
  TICKET_SOLD = 'TICKET_SOLD',
  VENUE_CONFIRMED = 'VENUE_CONFIRMED',
  INVITATION_ACCEPTED = 'INVITATION_ACCEPTED',
  EVENT_REMINDER = 'EVENT_REMINDER',
}

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(NotificationType),
    required: true,
  })
  type!: NotificationType;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ type: Boolean, default: false })
  read!: boolean;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ userId: 1, read: 1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 }); // 90 days TTL
