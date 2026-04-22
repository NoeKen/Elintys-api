import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GuestDocument = HydratedDocument<Guest>;

export enum GuestStatus {
  INVITED = 'invited',
  CONFIRMED = 'confirmed',
  DECLINED = 'declined',
  PRESENT = 'present',
}

@Schema({ timestamps: true })
export class Guest {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 100 })
  name!: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  @Prop({ enum: Object.values(GuestStatus), default: GuestStatus.INVITED })
  status!: GuestStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  addedBy?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 500 })
  note?: string;
}

export const GuestSchema = SchemaFactory.createForClass(Guest);
GuestSchema.index({ event: 1 });
GuestSchema.index({ event: 1, email: 1 });
