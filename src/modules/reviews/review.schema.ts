import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ReviewDocument = HydratedDocument<Review>;

export enum ReviewTargetType {
  EVENT = 'event',
  VENDOR = 'vendor',
  VENUE = 'venue',
}

@Schema({ timestamps: true })
export class Review {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  author!: Types.ObjectId;

  @Prop({ enum: Object.values(ReviewTargetType), required: true })
  targetType!: ReviewTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId!: Types.ObjectId;

  @Prop({ required: true, min: 1, max: 5 })
  rating!: number;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  comment!: string;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ targetType: 1, targetId: 1 });
ReviewSchema.index({ author: 1 });
ReviewSchema.index({ author: 1, targetType: 1, targetId: 1 }, { unique: true });
