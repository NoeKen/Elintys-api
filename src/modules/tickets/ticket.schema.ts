import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TicketTypeDocument = HydratedDocument<TicketType>;
export type TicketPurchaseDocument = HydratedDocument<TicketPurchase>;

export enum TicketPurchaseStatus {
  PENDING = 'pending',
  VALID = 'valid',
  USED = 'used',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

@Schema({ timestamps: true })
export class TicketType {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 100 })
  name!: string;

  @Prop({ default: 0, min: 0 })
  price!: number;

  @Prop({ required: true, min: 1 })
  quantity!: number;

  @Prop({ default: 0, min: 0 })
  sold!: number;

  @Prop({ default: false })
  isFree!: boolean;

  @Prop({ maxlength: 500 })
  description?: string;
}

export const TicketTypeSchema = SchemaFactory.createForClass(TicketType);
TicketTypeSchema.index({ event: 1 });

@Schema({ timestamps: true })
export class TicketPurchase {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  buyerId!: Types.ObjectId | null;

  @Prop({ trim: true, lowercase: true })
  guestEmail?: string;

  @Prop({ type: Types.ObjectId, ref: 'TicketType', required: true })
  ticketType!: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  price!: number;

  @Prop({ unique: true, sparse: true })
  qrCode?: string;

  @Prop({ enum: Object.values(TicketPurchaseStatus), default: TicketPurchaseStatus.PENDING })
  status!: TicketPurchaseStatus;

  @Prop()
  stripePaymentIntentId?: string;

  @Prop()
  scannedAt?: Date;
}

export const TicketPurchaseSchema = SchemaFactory.createForClass(TicketPurchase);
TicketPurchaseSchema.index({ event: 1 });
TicketPurchaseSchema.index({ buyerId: 1 });
TicketPurchaseSchema.index({ guestEmail: 1 });
