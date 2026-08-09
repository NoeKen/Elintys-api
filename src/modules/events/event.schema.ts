import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  MediaImage,
  MediaImageSchema,
} from '../media/media-image.schema';

export type EventDocument = HydratedDocument<Event>;

export enum EventStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
}

export enum EventVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  INVITE_ONLY = 'invite_only',
}

export enum EventDiscoverability {
  PUBLIC = 'public',
  UNLISTED = 'unlisted',
  PRIVATE = 'private',
}

export enum EventAccessPolicyType {
  OPEN = 'open',
  REGISTRATION_REQUIRED = 'registration_required',
  ACCESS_CODE = 'access_code',
  EMAIL_DOMAIN = 'email_domain',
  MANUAL_APPROVAL = 'manual_approval',
  GUEST_LIST = 'guest_list',
  INVITATION_TOKEN = 'invitation_token',
}

export enum AdmissionMode {
  FREE = 'free',
  REGISTRATION_ONLY = 'registration_only',
  FREE_TICKET = 'free_ticket',
  PAID_TICKET = 'paid_ticket',
  INVITATION = 'invitation',
}

export enum EventLocationType {
  PHYSICAL = 'physical',
  ONLINE = 'online',
  HYBRID = 'hybrid',
}

export enum EventType {
  CONFERENCE = 'conference',
  WEDDING = 'wedding',
  GALA = 'gala',
  CONCERT = 'concert',
  FESTIVAL = 'festival',
  WORKSHOP = 'workshop',
  CORPORATE = 'corporate',
  BIRTHDAY = 'birthday',
  NETWORKING = 'networking',
  OTHER = 'other',
}

export enum VenueMode {
  EXISTING = 'existing',
  SEARCH = 'search',
  LATER = 'later',
}

export enum ProviderSelectionMode {
  ELINTYS = 'elintys',
  MANUAL = 'manual',
  LATER = 'later',
}

@Schema({ _id: false })
class EventLocation {
  @Prop({ enum: Object.values(EventLocationType), default: EventLocationType.PHYSICAL })
  type!: EventLocationType;

  @Prop({ trim: true, maxlength: 200 })
  name?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true, maxlength: 100 })
  province?: string;

  @Prop({ trim: true, maxlength: 20 })
  postalCode?: string;

  @Prop({ trim: true, maxlength: 100 })
  contactName?: string;

  @Prop({ trim: true, lowercase: true, maxlength: 200 })
  contactEmail?: string;

  @Prop({ trim: true, maxlength: 50 })
  contactPhone?: string;

  @Prop()
  onlineUrl?: string;
}

@Schema({ _id: false })
class ProviderNeed {
  @Prop({ required: true, trim: true, maxlength: 50 })
  category!: string;

  @Prop({
    required: true,
    enum: Object.values(ProviderSelectionMode),
    default: ProviderSelectionMode.LATER,
  })
  mode!: ProviderSelectionMode;
}

@Schema({ _id: false })
class EventAccessRules {
  @Prop({ default: false })
  privateLink!: boolean;

  @Prop({ default: false })
  accessCode!: boolean;

  @Prop({ trim: true, lowercase: true, maxlength: 200 })
  allowedEmailDomain?: string;

  @Prop({ default: false })
  manualApproval!: boolean;
}

@Schema({ _id: false, discriminatorKey: 'type' })
export class EventAccessPolicy {
  @Prop({
    required: true,
    enum: Object.values(EventAccessPolicyType),
    default: EventAccessPolicyType.OPEN,
  })
  type!: EventAccessPolicyType;

  @Prop({ default: false })
  requiresAuthentication?: boolean;

  @Prop({ type: [String], default: [] })
  allowedDomains?: string[];

  @Prop({ select: false })
  codeHash?: string;
}

const EventAccessPolicySchema = SchemaFactory.createForClass(EventAccessPolicy);

@Schema({ _id: false })
class EventCreationProgress {
  @Prop({ min: 1, max: 6, default: 1 })
  currentStep!: number;

  @Prop({ type: [Number], default: [] })
  completedSteps!: number[];

  @Prop({ type: [Number], default: [] })
  skippedSteps!: number[];

  @Prop({ default: Date.now })
  lastSavedAt!: Date;
}

@Schema({ timestamps: true })
export class Event {
  @Prop({ required: true, trim: true, maxlength: 200 })
  title!: string;

  @Prop({ enum: Object.values(EventType) })
  eventType?: EventType;

  @Prop({ maxlength: 500 })
  shortDescription?: string;

  @Prop({ maxlength: 5000 })
  description?: string;

  /**
   * Les chaînes sont tolérées temporairement en lecture pour les six couvertures
   * Unsplash héritées. Toute nouvelle écriture utilise MediaImage.
   */
  @Prop({ type: MediaImageSchema })
  coverImage?: MediaImage | string;

  @Prop({ type: [MediaImageSchema], default: [] })
  gallery!: MediaImage[];

  @Prop()
  startDate?: Date;

  @Prop()
  endDate?: Date;

  @Prop({ type: EventLocation })
  location?: EventLocation;

  @Prop({ default: 'America/Toronto', trim: true, maxlength: 100 })
  timezone!: string;

  @Prop({ default: false })
  dateIsTentative!: boolean;

  @Prop({ enum: Object.values(VenueMode) })
  venueMode?: VenueMode;

  @Prop({ type: Types.ObjectId, ref: 'VenueProfile' })
  venueProfile?: Types.ObjectId;

  @Prop({ enum: Object.values(EventVisibility), default: EventVisibility.PUBLIC })
  visibility!: EventVisibility;

  @Prop({ type: EventAccessRules })
  accessRules?: EventAccessRules;

  @Prop({
    enum: Object.values(EventDiscoverability),
    default: EventDiscoverability.PUBLIC,
  })
  discoverability!: EventDiscoverability;

  @Prop({ type: EventAccessPolicySchema, default: () => ({ type: EventAccessPolicyType.OPEN }) })
  accessPolicy!: EventAccessPolicy;

  @Prop({
    type: [String],
    enum: Object.values(AdmissionMode),
    default: [AdmissionMode.REGISTRATION_ONLY],
  })
  admissionModes!: AdmissionMode[];

  @Prop({ default: 2, min: 1 })
  accessModelVersion!: number;

  @Prop({ enum: Object.values(EventStatus), default: EventStatus.DRAFT })
  status!: EventStatus;

  /** Archive opérationnelle, indépendante du cycle de vie de publication. */
  @Prop({ type: Date, default: null })
  archivedAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  organizer!: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'VendorProfile' }], default: [] })
  vendors!: Types.ObjectId[];

  @Prop({ type: [ProviderNeed], default: [] })
  providerNeeds!: ProviderNeed[];

  @Prop({ type: EventCreationProgress, default: () => ({}) })
  creationProgress!: EventCreationProgress;

  @Prop({ trim: true, lowercase: true })
  slug?: string;

  @Prop({ default: 0 })
  capacity!: number;
}

export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.index({ slug: 1 }, { unique: true, sparse: true });
EventSchema.index({ organizer: 1, status: 1 });
EventSchema.index({ organizer: 1, archivedAt: 1, updatedAt: -1 });
EventSchema.index({ startDate: 1 });
EventSchema.index({ 'location.city': 1, status: 1 });
EventSchema.index({ eventType: 1, status: 1, visibility: 1 });
EventSchema.index({ eventType: 1, status: 1, discoverability: 1 });
