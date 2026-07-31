import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type VendorProfileDocument = HydratedDocument<VendorProfile>;

export enum VendorCategory {
  PHOTOGRAPHE = 'photographe',
  TRAITEUR = 'traiteur',
  DECORATEUR = 'decorateur',
  ANIMATEUR = 'animateur',
  DJ = 'dj',
  SONORISATION = 'sonorisation',
  AUTRE = 'autre',
}

@Schema({ _id: false })
class PriceRange {
  @Prop({ min: 0 })
  min?: number;

  @Prop({ min: 0 })
  max?: number;

  @Prop({ default: 'CAD', maxlength: 3 })
  currency!: string;
}

@Schema({ timestamps: true })
export class VendorProfile {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  user!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 200 })
  businessName!: string;

  @Prop({ enum: Object.values(VendorCategory), required: true })
  category!: VendorCategory;

  @Prop({ maxlength: 3000 })
  description?: string;

  @Prop({ type: [String], default: [] })
  photos!: string[];

  @Prop({ type: PriceRange })
  priceRange?: PriceRange;

  @Prop({ trim: true, default: 'Montréal, QC', maxlength: 200 })
  serviceArea!: string;

  @Prop({ trim: true, lowercase: true })
  contactEmail?: string;

  @Prop({ trim: true })
  contactPhone?: string;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ default: false })
  isPremium!: boolean;

  @Prop({ default: 0, min: 0, max: 5 })
  rating!: number;

  @Prop({ default: 0, min: 0 })
  reviewCount!: number;
}

export const VendorProfileSchema = SchemaFactory.createForClass(VendorProfile);
VendorProfileSchema.index({ category: 1, isActive: 1 });
VendorProfileSchema.index({ serviceArea: 1, isActive: 1 });
VendorProfileSchema.index({ 'priceRange.min': 1, isActive: 1 });
VendorProfileSchema.index({ rating: -1 });

export type VendorRequestDocument = HydratedDocument<VendorRequest>;

export enum VendorRequestStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
}

export enum VendorRequestSource {
  PLATFORM = 'platform',
  MANUAL = 'manual',
}

export class ExternalVendorContact {
  name!: string;
  email?: string;
  phone?: string;
  category?: string;
}

@Schema({ timestamps: true })
export class VendorRequest {
  @Prop({ type: Types.ObjectId, ref: 'Event', required: true })
  event!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'VendorProfile' })
  vendor?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  organizer!: Types.ObjectId;

  @Prop({ type: String, maxlength: 500 })
  message?: string;

  @Prop({
    type: String,
    enum: Object.values(VendorRequestStatus),
    default: VendorRequestStatus.PENDING,
  })
  status!: VendorRequestStatus;

  @Prop({ type: String, maxlength: 500 })
  responseMessage?: string;

  @Prop()
  respondedAt?: Date;

  @Prop({
    type: String,
    enum: Object.values(VendorRequestSource),
    default: VendorRequestSource.PLATFORM,
  })
  source!: VendorRequestSource;

  @Prop({ type: Object, default: null })
  externalContact?: ExternalVendorContact | null;
}

export const VendorRequestSchema = SchemaFactory.createForClass(VendorRequest);
VendorRequestSchema.index({ event: 1 });
VendorRequestSchema.index({ vendor: 1, status: 1 });
VendorRequestSchema.index({ organizer: 1 });
