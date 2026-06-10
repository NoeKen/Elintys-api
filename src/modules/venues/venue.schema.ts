import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type VenueProfileDocument = HydratedDocument<VenueProfile>;

@Schema({ _id: false })
class VenueAddress {
  @Prop({ required: true, trim: true })
  street!: string;

  @Prop({ required: true, trim: true, default: 'Montréal' })
  city!: string;

  @Prop({ trim: true, default: 'QC' })
  province!: string;

  @Prop({ trim: true })
  postalCode?: string;
}

@Schema({ timestamps: true })
export class VenueProfile {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  user!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 200 })
  name!: string;

  @Prop({ maxlength: 3000 })
  description?: string;

  @Prop({ type: VenueAddress, required: true })
  address!: VenueAddress;

  @Prop({ required: true, min: 1 })
  capacity!: number;

  @Prop({ type: [String], default: [] })
  photos!: string[];

  @Prop({ type: [String], default: [] })
  amenities!: string[];

  @Prop({ min: 0 })
  pricePerDay?: number;

  @Prop({ trim: true, lowercase: true })
  contactEmail?: string;

  @Prop({ trim: true })
  contactPhone?: string;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ default: 0, min: 0, max: 5 })
  rating!: number;

  @Prop({ default: 0, min: 0 })
  reviewCount!: number;
}

export const VenueProfileSchema = SchemaFactory.createForClass(VenueProfile);
VenueProfileSchema.index({ 'address.city': 1, isActive: 1 });
VenueProfileSchema.index({ capacity: 1 });

export type VenueBookingDocument = HydratedDocument<VenueBooking>;

export enum VenueBookingStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  REFUSED = 'refused',
  CANCELLED = 'cancelled',
}

export enum VenueBookingSource {
  PLATFORM = 'platform',
  MANUAL = 'manual',
  EXTERNAL = 'external',
}

export class ExternalVenueContact {
  name!: string;
  email?: string;
  phone?: string;
  address?: string;
}

@Schema({ timestamps: true })
export class VenueBooking {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'VenueProfile' })
  venue?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  organizer!: Types.ObjectId;

  @Prop({ required: true })
  bookingStart!: Date;

  @Prop({ required: true })
  bookingEnd!: Date;

  @Prop({ type: String, maxlength: 500 })
  message?: string;

  @Prop({
    type: String,
    enum: Object.values(VenueBookingStatus),
    default: VenueBookingStatus.PENDING,
  })
  status!: VenueBookingStatus;

  @Prop({ type: Number, min: 0 })
  totalPrice?: number;

  @Prop({ type: String, default: 'CAD' })
  currency!: string;

  @Prop({ type: String, maxlength: 500 })
  responseMessage?: string;

  @Prop()
  respondedAt?: Date;

  @Prop({
    type: String,
    enum: Object.values(VenueBookingSource),
    default: VenueBookingSource.PLATFORM,
  })
  source!: VenueBookingSource;

  @Prop({ type: Object, default: null })
  externalContact?: ExternalVenueContact | null;
}

export const VenueBookingSchema = SchemaFactory.createForClass(VenueBooking);
VenueBookingSchema.index({ event: 1 });
VenueBookingSchema.index({ venue: 1, status: 1 });
VenueBookingSchema.index({ organizer: 1 });
