import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FavoriteDocument = HydratedDocument<Favorite>;

export enum FavoriteTargetType {
  EVENT = 'event',
  VENDOR = 'vendor',
  VENUE = 'venue',
}

@Schema({ timestamps: true })
export class Favorite {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user!: Types.ObjectId;

  @Prop({ enum: Object.values(FavoriteTargetType), required: true })
  targetType!: FavoriteTargetType;

  @Prop({ type: Types.ObjectId, required: true })
  targetId!: Types.ObjectId;
}

export const FavoriteSchema = SchemaFactory.createForClass(Favorite);
FavoriteSchema.index({ user: 1, targetType: 1 });
FavoriteSchema.index({ user: 1, targetType: 1, targetId: 1 }, { unique: true });
