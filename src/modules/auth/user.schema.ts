import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import * as bcrypt from 'bcrypt';

export type UserDocument = HydratedDocument<User>;

export enum UserRole {
  ADMIN = 'admin',
  ORGANISATEUR = 'organisateur',
  PRESTATAIRE = 'prestataire',
  PARTICIPANT = 'participant',
  GESTIONNAIRE_SALLE = 'gestionnaire_salle',
}

export interface EmailNotificationPreferences {
  vendorRequestReceived: boolean;
  vendorResponse: boolean;
  venueBookingReceived: boolean;
  venueResponse: boolean;
}

export const DEFAULT_EMAIL_NOTIFICATION_PREFERENCES: EmailNotificationPreferences = {
  vendorRequestReceived: true,
  vendorResponse: true,
  venueBookingReceived: true,
  venueResponse: true,
};

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, trim: true, maxlength: 100 })
  fullName!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 255 })
  email!: string;

  @Prop({ required: true, minlength: 8, select: false })
  password!: string;

  @Prop({ type: [String], enum: Object.values(UserRole), default: [UserRole.ORGANISATEUR] })
  roles!: UserRole[];

  @Prop({ default: false })
  isEmailVerified!: boolean;

  @Prop({ select: false })
  emailVerificationToken?: string;

  @Prop({ select: false })
  emailVerificationExpiresAt?: Date;

  @Prop({ select: false })
  passwordResetToken?: string;

  @Prop({ select: false })
  passwordResetExpires?: Date;

  @Prop({ select: false })
  refreshToken?: string;

  @Prop({ type: Number, default: 0, min: 0 })
  referralBalance!: number;

  @Prop({ type: [Object], default: [] })
  subscriptions!: Record<string, unknown>[];

  @Prop({ default: false })
  onboardingCompleted!: boolean;

  @Prop({ type: Object, default: {} })
  onboardingByRole!: Record<string, boolean>;

  @Prop({ type: Object, default: {} })
  onboardingData!: Record<string, Record<string, unknown>>;

  @Prop({
    type: {
      vendorRequestReceived: { type: Boolean, default: true },
      vendorResponse: { type: Boolean, default: true },
      venueBookingReceived: { type: Boolean, default: true },
      venueResponse: { type: Boolean, default: true },
    },
    _id: false,
    default: () => ({ ...DEFAULT_EMAIL_NOTIFICATION_PREFERENCES }),
  })
  emailNotifications!: EmailNotificationPreferences;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password as string, 12);
  next();
});
