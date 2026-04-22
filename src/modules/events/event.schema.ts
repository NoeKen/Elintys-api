import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EventDocument = HydratedDocument<Event>;

export enum EventStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
}

export enum EventVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  INVITE_ONLY = 'invite_only',
}

export enum EventLocationType {
  PHYSICAL = 'physical',
  ONLINE = 'online',
  HYBRID = 'hybrid',
}

@Schema({ _id: false })
class EventLocation {
  @Prop({ enum: Object.values(EventLocationType), default: EventLocationType.PHYSICAL })
  type!: EventLocationType;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  city?: string;

  @Prop()
  onlineUrl?: string;
}

@Schema({ timestamps: true })
export class Event {
  @Prop({ required: true, trim: true, maxlength: 200 })
  title!: string;

  @Prop({ maxlength: 5000 })
  description?: string;

  @Prop()
  coverImage?: string;

  @Prop({ required: true })
  startDate!: Date;

  @Prop()
  endDate?: Date;

  @Prop({ type: EventLocation })
  location!: EventLocation;

  @Prop({ enum: Object.values(EventVisibility), default: EventVisibility.PUBLIC })
  visibility!: EventVisibility;

  @Prop({ enum: Object.values(EventStatus), default: EventStatus.DRAFT })
  status!: EventStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  organizer!: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'VendorProfile' }], default: [] })
  vendors!: Types.ObjectId[];

  @Prop({ unique: true, sparse: true, trim: true, lowercase: true })
  slug?: string;

  @Prop({ default: 0 })
  capacity!: number;
}

export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.index({ organizer: 1, status: 1 });
EventSchema.index({ startDate: 1 });
EventSchema.index({ slug: 1 });
EventSchema.index({ 'location.city': 1, status: 1 });
