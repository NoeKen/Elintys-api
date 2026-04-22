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
VendorProfileSchema.index({ rating: -1 });
