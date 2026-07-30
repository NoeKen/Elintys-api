import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MediaCleanupTaskDocument = HydratedDocument<MediaCleanupTask>;

@Schema({ timestamps: true })
export class MediaCleanupTask {
  @Prop({ required: true, unique: true, index: true, trim: true })
  publicId!: string;

  @Prop({ required: true, default: 0 })
  attempts!: number;

  @Prop({ required: true, default: Date.now, index: true })
  nextAttemptAt!: Date;

  @Prop()
  lastAttemptAt?: Date;
}

export const MediaCleanupTaskSchema =
  SchemaFactory.createForClass(MediaCleanupTask);
