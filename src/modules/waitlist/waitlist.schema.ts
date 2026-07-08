import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WaitlistEntryDocument = HydratedDocument<WaitlistEntry>;

export enum WaitlistRole {
  ORGANISATEUR = 'organisateur',
  PRESTATAIRE = 'prestataire',
  GESTIONNAIRE = 'gestionnaire',
  VISITEUR = 'visiteur',
}

export enum WaitlistSource {
  HERO = 'hero',
  CTA = 'cta',
}

@Schema({ timestamps: true })
export class WaitlistEntry {
  @Prop({ required: true, trim: true, maxlength: 50 })
  firstName!: string;

  @Prop({ required: true, trim: true, lowercase: true })
  email!: string;

  @Prop({ enum: Object.values(WaitlistRole), required: true })
  role!: WaitlistRole;

  @Prop({ enum: Object.values(WaitlistSource), required: true })
  source!: WaitlistSource;

  @Prop({ required: true, default: false })
  consentMarketing!: boolean;
}

export const WaitlistEntrySchema = SchemaFactory.createForClass(WaitlistEntry);
WaitlistEntrySchema.index({ email: 1 }, { unique: true });
