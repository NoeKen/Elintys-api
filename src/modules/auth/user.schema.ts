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
  passwordResetToken?: string;

  @Prop({ select: false })
  passwordResetExpires?: Date;

  @Prop({ select: false })
  refreshToken?: string;

  @Prop({ type: Number, default: 0, min: 0 })
  referralBalance!: number;

  @Prop({ type: [Object], default: [] })
  subscriptions!: Record<string, unknown>[];
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password as string, 12);
  next();
});
