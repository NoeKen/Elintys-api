import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EventAccessRequestDocument = HydratedDocument<EventAccessRequest>;

export enum EventAccessRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Schema({ timestamps: true })
export class EventAccessRequest {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  eventId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ enum: Object.values(EventAccessRequestStatus), default: EventAccessRequestStatus.PENDING })
  status!: EventAccessRequestStatus;

  @Prop({ default: Date.now })
  requestedAt!: Date;

  @Prop()
  reviewedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedBy?: Types.ObjectId;
}

export const EventAccessRequestSchema = SchemaFactory.createForClass(EventAccessRequest);
EventAccessRequestSchema.index({ eventId: 1, userId: 1 }, { unique: true });
EventAccessRequestSchema.index({ eventId: 1, status: 1 });
