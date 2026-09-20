import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ReviewDocument = HydratedDocument<Review>;

export enum ReviewTargetType {
  EVENT = 'event',
  VENDOR = 'vendor',
  VENUE = 'venue',
  ORGANIZER = 'organizer',
}

export enum ReviewContextType {
  EVENT = 'event',
  VENDOR_REQUEST = 'vendor_request',
  VENUE_BOOKING = 'venue_booking',
}

export enum ReviewDirection {
  PARTICIPANT_EVENT = 'participant_event',
  ORGANIZER_VENDOR = 'organizer_vendor',
  VENDOR_ORGANIZER = 'vendor_organizer',
  ORGANIZER_VENUE = 'organizer_venue',
  VENUE_ORGANIZER = 'venue_organizer',
}

@Schema({ timestamps: true, autoIndex: false })
export class Review {
  @Prop({ default: 2, immutable: true })
  schemaVersion!: number;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  author!: Types.ObjectId;

  @Prop({ enum: Object.values(ReviewTargetType), required: true })
  targetType!: ReviewTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId!: Types.ObjectId;

  @Prop({ enum: Object.values(ReviewContextType), required: true, immutable: true })
  contextType!: ReviewContextType;

  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  contextId!: Types.ObjectId;

  @Prop({ enum: Object.values(ReviewDirection), required: true, immutable: true })
  direction!: ReviewDirection;

  @Prop({ required: true, immutable: true })
  verifiedAt!: Date;

  @Prop({ required: true, min: 1, max: 5 })
  rating!: number;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  comment!: string;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ targetType: 1, targetId: 1 });
ReviewSchema.index({ author: 1 });
ReviewSchema.index(
  { author: 1, contextType: 1, contextId: 1, direction: 1 },
  {
    unique: true,
    name: 'review_verified_context_unique',
    partialFilterExpression: { schemaVersion: 2 },
  },
);
ReviewSchema.index({ targetType: 1, targetId: 1, createdAt: -1, _id: -1 }, { name: 'review_public_feed' });
