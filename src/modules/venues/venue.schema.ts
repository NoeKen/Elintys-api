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
