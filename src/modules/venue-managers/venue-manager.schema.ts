import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type VenueManagerProfileDocument = HydratedDocument<VenueManagerProfile>;

@Schema({ timestamps: true, collection: 'venuemanagerprofiles', autoIndex: false })
export class VenueManagerProfile {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true, immutable: true })
  user!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 200 })
  professionalName!: string;

  @Prop({ trim: true, maxlength: 3000 })
  description?: string;

  @Prop({ trim: true, maxlength: 150 })
  region?: string;

  @Prop({ trim: true, lowercase: true })
  contactEmail?: string;

  @Prop({ trim: true, maxlength: 30 })
  contactPhone?: string;
}

export const VenueManagerProfileSchema = SchemaFactory.createForClass(VenueManagerProfile);
