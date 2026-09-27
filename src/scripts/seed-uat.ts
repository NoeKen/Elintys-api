import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import mongoose, { Connection, Types } from 'mongoose';
import { User, UserRole, UserSchema } from '../modules/auth/user.schema';
import {
  AdmissionMode,
  Event,
  EventAccessPolicyType,
  EventDiscoverability,
  EventLocationType,
  EventSchema,
  EventStatus,
  EventType,
  EventVisibility,
  VenueMode,
} from '../modules/events/event.schema';
import {
  EventRegistration,
  EventRegistrationSchema,
  EventRegistrationStatus,
} from '../modules/event-registration/event-registration.schema';
import { Guest, GuestSchema, GuestStatus } from '../modules/guests/guest.schema';
import {
  Invitation,
  InvitationSchema,
  InvitationStatus,
  InvitationType,
} from '../modules/invitations/invitation.schema';
import {
  Review,
  ReviewContextType,
  ReviewDirection,
  ReviewSchema,
  ReviewTargetType,
} from '../modules/reviews/review.schema';
import {
  TicketPurchase,
  TicketPurchaseSchema,
  TicketPurchaseStatus,
  TicketType,
  TicketTypeSchema,
} from '../modules/tickets/ticket.schema';
import {
  VendorCategory,
  VendorProfile,
  VendorProfileSchema,
  VendorRequest,
  VendorRequestSchema,
  VendorRequestStatus,
} from '../modules/vendors/vendor.schema';
import {
  VenueManagerProfile,
  VenueManagerProfileSchema,
} from '../modules/venue-managers/venue-manager.schema';
import {
  VenueBooking,
  VenueBookingSchema,
  VenueBookingStatus,
  VenueProfile,
  VenueProfileSchema,
  VenueType,
} from '../modules/venues/venue.schema';
import {
  GuardedTarget,
  ScriptGuardError,
  assertConnectedDatabase,
  assertUatTarget,
  describeMongoUri,
  formatSafeError,
} from './lib/environment-guard';
import { flagValue, parseCliFlags, requireExplicitEnvFile } from './lib/script-cli';

/**
 * seed-uat.ts — jeu de données FICTIF et idempotent de la recette (UAT).
 *
 *   npm run seed:uat -- --env-file=.env.uat.local
 *
 * Gardes : ELINTYS_ENV=uat ET base exactement `elintys-uat` (tout le reste,
 * production comprise, est refusé avant connexion puis revérifié après).
 *
 * Idempotence : chaque document est upserté par une clé fonctionnelle fixe
 * (email, slug, couple utilisateur/profil…) ; relancer le seed ne duplique rien.
 * Écritures via les modèles Mongoose (`runValidators: true`).
 *
 * Données : adresses sur le domaine réservé non routable `uat.elintys.test`
 * (RFC 2606). Mot de passe commun lu dans `UAT_SEED_PASSWORD` (≥ 12 caractères),
 * jamais affiché, jamais commité ; seul son hash bcrypt est stocké.
 *
 * Index : les collections `autoIndex: false` (salles, gestionnaires, avis,
 * inscriptions, commandes…) reçoivent leurs index via les migrations
 * (`--environment=uat`), à exécuter AVANT ce seed sur une base neuve.
 */

export const UAT_EMAIL_DOMAIN = 'uat.elintys.test';
export const UAT_SEED_PASSWORD_ENV = 'UAT_SEED_PASSWORD';
const BCRYPT_ROUNDS = 12;

export interface UatAccount {
  key: string;
  fullName: string;
  email: string;
  roles: UserRole[];
  verified: boolean;
  purpose: string;
}

function account(key: string, fullName: string, local: string, role: UserRole, purpose: string, verified = true): UatAccount {
  return { key, fullName, email: `${local}@${UAT_EMAIL_DOMAIN}`, roles: [role], verified, purpose };
}

export const UAT_ACCOUNTS: readonly UatAccount[] = [
  account('participant-a', 'Alice Participante', 'participant.a', UserRole.PARTICIPANT, 'billets, inscription, avis'),
  account('participant-b', 'Bruno Participant', 'participant.b', UserRole.PARTICIPANT, 'invité liste privée, avis'),
  account('participant-unverified', 'Ursule Nonverifiee', 'participant.unverified', UserRole.PARTICIPANT, 'mode lecture seule (courriel non vérifié)', false),
  account('organizer-a', 'Olivier Organisateur', 'organizer.a', UserRole.ORGANISATEUR, 'propriétaire des événements de recette'),
  account('organizer-b', 'Odile Organisatrice', 'organizer.b', UserRole.ORGANISATEUR, 'tiers non propriétaire (IDOR)'),
  account('vendor-a', 'Valerie Prestataire', 'vendor.a', UserRole.PRESTATAIRE, 'photographe, demande acceptée, avis'),
  account('vendor-b', 'Victor Prestataire', 'vendor.b', UserRole.PRESTATAIRE, 'traiteur sans demande'),
  account('venue-manager-a', 'Gaston Gestionnaire', 'venue.manager.a', UserRole.GESTIONNAIRE_SALLE, 'deux salles, réservation confirmée'),
  account('venue-manager-b', 'Gisele Gestionnaire', 'venue.manager.b', UserRole.GESTIONNAIRE_SALLE, 'une salle'),
];

export function assertSeedPassword(password: string | undefined): string {
  if (!password) throw new ScriptGuardError('UAT_SEED_PASSWORD_REQUIRED', `${UAT_SEED_PASSWORD_ENV} est requis`);
  if (password.length < 12) throw new ScriptGuardError('UAT_SEED_PASSWORD_TOO_SHORT', 'au moins 12 caractères');
  // bcrypt ignore tout au-delà de 72 octets : refuser plutôt que tronquer silencieusement.
  if (Buffer.byteLength(password, 'utf8') > 72) throw new ScriptGuardError('UAT_SEED_PASSWORD_TOO_LONG', '72 octets maximum');
  return password;
}

// ── Définitions d'événements (pures, testées contre la policy d'accès) ─────

export interface UatTicketTypeDef {
  name: string;
  price: number;
  quantity: number;
  isFree: boolean;
}

export interface UatEventDef {
  slug: string;
  organizerKey: 'organizer-a' | 'organizer-b';
  venueName?: string;
  title: string;
  eventType: EventType;
  status: EventStatus;
  visibility: EventVisibility;
  discoverability: EventDiscoverability;
  accessPolicy: { type: EventAccessPolicyType; requiresAuthentication?: boolean };
  admissionModes: AdmissionMode[];
  startDate: Date;
  endDate: Date;
  capacity: number;
  ticketTypes: UatTicketTypeDef[];
}

const FREE_TICKET: UatTicketTypeDef = { name: 'Entrée gratuite', price: 0, quantity: 100, isFree: true };
const PAID_TICKET: UatTicketTypeDef = { name: 'Billet soutien', price: 25, quantity: 50, isFree: false };

export const UAT_EVENTS: readonly UatEventDef[] = [
  {
    slug: 'uat-public-conference', organizerKey: 'organizer-a', venueName: 'UAT Salle Alpha',
    title: 'UAT — Conférence publique', eventType: EventType.CONFERENCE, status: EventStatus.PUBLISHED,
    visibility: EventVisibility.PUBLIC, discoverability: EventDiscoverability.PUBLIC,
    accessPolicy: { type: EventAccessPolicyType.OPEN }, admissionModes: [AdmissionMode.FREE_TICKET, AdmissionMode.PAID_TICKET],
    startDate: new Date('2027-03-10T14:00:00.000Z'), endDate: new Date('2027-03-10T22:00:00.000Z'), capacity: 150,
    ticketTypes: [FREE_TICKET, PAID_TICKET],
  },
  {
    slug: 'uat-unlisted-workshop', organizerKey: 'organizer-a', venueName: 'UAT Salle Beta',
    title: 'UAT — Atelier non répertorié', eventType: EventType.WORKSHOP, status: EventStatus.PUBLISHED,
    visibility: EventVisibility.PUBLIC, discoverability: EventDiscoverability.UNLISTED,
    accessPolicy: { type: EventAccessPolicyType.REGISTRATION_REQUIRED, requiresAuthentication: true },
    admissionModes: [AdmissionMode.REGISTRATION_ONLY],
    startDate: new Date('2027-04-14T15:00:00.000Z'), endDate: new Date('2027-04-14T19:00:00.000Z'), capacity: 40, ticketTypes: [],
  },
  {
    slug: 'uat-private-gala', organizerKey: 'organizer-a', venueName: 'UAT Salle Alpha',
    title: 'UAT — Gala privé sur liste', eventType: EventType.GALA, status: EventStatus.PUBLISHED,
    visibility: EventVisibility.PRIVATE, discoverability: EventDiscoverability.PRIVATE,
    accessPolicy: { type: EventAccessPolicyType.GUEST_LIST, requiresAuthentication: true },
    admissionModes: [AdmissionMode.INVITATION],
    startDate: new Date('2027-05-20T23:00:00.000Z'), endDate: new Date('2027-05-21T03:00:00.000Z'), capacity: 80, ticketTypes: [],
  },
  {
    slug: 'uat-draft-festival', organizerKey: 'organizer-a',
    title: 'UAT — Festival (brouillon)', eventType: EventType.FESTIVAL, status: EventStatus.DRAFT,
    visibility: EventVisibility.PUBLIC, discoverability: EventDiscoverability.PUBLIC,
    accessPolicy: { type: EventAccessPolicyType.OPEN }, admissionModes: [AdmissionMode.REGISTRATION_ONLY],
    startDate: new Date('2027-07-01T16:00:00.000Z'), endDate: new Date('2027-07-02T02:00:00.000Z'), capacity: 300, ticketTypes: [],
  },
  {
    slug: 'uat-completed-concert', organizerKey: 'organizer-a', venueName: 'UAT Salle Alpha',
    title: 'UAT — Concert terminé', eventType: EventType.CONCERT, status: EventStatus.COMPLETED,
    visibility: EventVisibility.PUBLIC, discoverability: EventDiscoverability.PUBLIC,
    accessPolicy: { type: EventAccessPolicyType.OPEN }, admissionModes: [AdmissionMode.FREE_TICKET],
    startDate: new Date('2026-05-15T23:00:00.000Z'), endDate: new Date('2026-05-16T03:00:00.000Z'), capacity: 120,
    ticketTypes: [FREE_TICKET],
  },
  {
    slug: 'uat-cancelled-networking', organizerKey: 'organizer-a', venueName: 'UAT Salle Beta',
    title: 'UAT — Réseautage annulé', eventType: EventType.NETWORKING, status: EventStatus.CANCELLED,
    visibility: EventVisibility.PUBLIC, discoverability: EventDiscoverability.PUBLIC,
    accessPolicy: { type: EventAccessPolicyType.OPEN }, admissionModes: [AdmissionMode.REGISTRATION_ONLY],
    startDate: new Date('2027-02-05T22:00:00.000Z'), endDate: new Date('2027-02-06T01:00:00.000Z'), capacity: 60, ticketTypes: [],
  },
  {
    slug: 'uat-organizer-b-meetup', organizerKey: 'organizer-b', venueName: 'UAT Salle Gamma',
    title: 'UAT — Rencontre de l’organisatrice B', eventType: EventType.CORPORATE, status: EventStatus.PUBLISHED,
    visibility: EventVisibility.PUBLIC, discoverability: EventDiscoverability.PUBLIC,
    accessPolicy: { type: EventAccessPolicyType.OPEN }, admissionModes: [AdmissionMode.FREE_TICKET],
    startDate: new Date('2027-06-09T13:00:00.000Z'), endDate: new Date('2027-06-09T17:00:00.000Z'), capacity: 50,
    ticketTypes: [FREE_TICKET],
  },
];

const VENUES = [
  { managerKey: 'venue-manager-a', name: 'UAT Salle Alpha', type: VenueType.RECEPTION, capacity: 200, city: 'Montréal', street: '100 rue Fictive' },
  { managerKey: 'venue-manager-a', name: 'UAT Salle Beta', type: VenueType.STUDIO, capacity: 60, city: 'Montréal', street: '200 rue Fictive' },
  { managerKey: 'venue-manager-b', name: 'UAT Salle Gamma', type: VenueType.CONFERENCE, capacity: 120, city: 'Québec', street: '300 rue Fictive' },
] as const;

const VENDORS = [
  { userKey: 'vendor-a', businessName: 'UAT Photo Studio', category: VendorCategory.PHOTOGRAPHE },
  { userKey: 'vendor-b', businessName: 'UAT Traiteur', category: VendorCategory.TRAITEUR },
] as const;

// ── Seed ────────────────────────────────────────────────────────────────────

const UPSERT = { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true } as const;

function models(connection: Connection) {
  return {
    user: connection.model<User>(User.name, UserSchema),
    vendor: connection.model<VendorProfile>(VendorProfile.name, VendorProfileSchema),
    vendorRequest: connection.model<VendorRequest>(VendorRequest.name, VendorRequestSchema),
    manager: connection.model<VenueManagerProfile>(VenueManagerProfile.name, VenueManagerProfileSchema),
    venue: connection.model<VenueProfile>(VenueProfile.name, VenueProfileSchema),
    booking: connection.model<VenueBooking>(VenueBooking.name, VenueBookingSchema),
    event: connection.model<Event>(Event.name, EventSchema),
    ticketType: connection.model<TicketType>(TicketType.name, TicketTypeSchema),
    ticket: connection.model<TicketPurchase>(TicketPurchase.name, TicketPurchaseSchema),
    registration: connection.model<EventRegistration>(EventRegistration.name, EventRegistrationSchema),
    guest: connection.model<Guest>(Guest.name, GuestSchema),
    invitation: connection.model<Invitation>(Invitation.name, InvitationSchema),
    review: connection.model<Review>(Review.name, ReviewSchema),
  };
}

function must<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new ScriptGuardError('UAT_SEED_INVARIANT_FAILED', `clé manquante '${key}'`);
  return value;
}

export interface UatSeedSummary {
  accounts: { email: string; roles: string; verified: boolean; purpose: string }[];
  counts: Record<string, number>;
}

export async function seedUatDatabase(connection: Connection, password: string): Promise<UatSeedSummary> {
  const m = models(connection);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const users = new Map<string, Types.ObjectId>();
  for (const input of UAT_ACCOUNTS) {
    const user = await m.user.findOneAndUpdate(
      { email: input.email },
      {
        $set: {
          fullName: input.fullName,
          roles: input.roles,
          password: passwordHash,
          isEmailVerified: input.verified,
          onboardingCompleted: true,
          onboardingByRole: Object.fromEntries(input.roles.map((role) => [role, true])),
        },
        $setOnInsert: { referralBalance: 0, subscriptions: [], onboardingData: {} },
        $unset: {
          emailVerificationToken: 1,
          emailVerificationExpiresAt: 1,
          passwordResetToken: 1,
          passwordResetExpires: 1,
          refreshToken: 1,
        },
      },
      UPSERT,
    );
    users.set(input.key, user._id);
  }

  const vendors = new Map<string, Types.ObjectId>();
  for (const input of VENDORS) {
    const user = must(users, input.userKey);
    const vendor = await m.vendor.findOneAndUpdate(
      { user },
      {
        $set: {
          businessName: input.businessName,
          category: input.category,
          description: 'Profil prestataire fictif de recette.',
          priceRange: { min: 500, max: 2500, currency: 'CAD' },
          serviceArea: 'Grand Montréal',
          contactEmail: UAT_ACCOUNTS.find((item) => item.key === input.userKey)?.email,
          isActive: true,
        },
      },
      UPSERT,
    );
    vendors.set(input.userKey, vendor._id);
  }

  const managers = new Map<string, Types.ObjectId>();
  for (const key of ['venue-manager-a', 'venue-manager-b']) {
    const user = must(users, key);
    const manager = await m.manager.findOneAndUpdate(
      { user },
      { $set: { professionalName: `Gestion ${key.endsWith('-a') ? 'A' : 'B'} (UAT)`, region: 'Québec', contactEmail: UAT_ACCOUNTS.find((item) => item.key === key)?.email } },
      UPSERT,
    );
    managers.set(key, manager._id);
  }

  const venues = new Map<string, Types.ObjectId>();
  for (const input of VENUES) {
    const managerProfile = must(managers, input.managerKey);
    // `user` et `managerProfile` sont immuables : ils ne figurent que dans le filtre (posés à l'insertion).
    const venue = await m.venue.findOneAndUpdate(
      { user: must(users, input.managerKey), managerProfile, name: input.name },
      {
        $set: {
          type: input.type,
          description: 'Salle fictive de recette.',
          address: { street: input.street, city: input.city, province: 'QC' },
          capacity: input.capacity,
          amenities: ['Wi-Fi', 'Accessibilité'],
          pricePerDay: 1500,
          isActive: true,
        },
      },
      UPSERT,
    );
    venues.set(input.name, venue._id);
  }

  const events = new Map<string, Types.ObjectId>();
  const ticketTypes = new Map<string, Types.ObjectId>();
  for (const input of UAT_EVENTS) {
    const published = input.status !== EventStatus.DRAFT;
    const event = await m.event.findOneAndUpdate(
      { slug: input.slug },
      {
        $set: {
          title: input.title,
          eventType: input.eventType,
          shortDescription: 'Événement fictif de recette Elintys.',
          description: 'Données fictives réservées à l’environnement de recette (UAT).',
          startDate: input.startDate,
          endDate: input.endDate,
          location: { type: EventLocationType.PHYSICAL, name: input.venueName ?? 'Lieu à confirmer', city: 'Montréal', province: 'Québec' },
          timezone: 'America/Toronto',
          venueMode: input.venueName ? VenueMode.EXISTING : VenueMode.LATER,
          ...(input.venueName ? { venueProfile: must(venues, input.venueName) } : {}),
          visibility: input.visibility,
          discoverability: input.discoverability,
          accessPolicy: input.accessPolicy,
          admissionModes: input.admissionModes,
          accessModelVersion: 2,
          status: input.status,
          publishedAt: published ? new Date('2026-04-01T12:00:00.000Z') : null,
          startedAt: input.status === EventStatus.COMPLETED ? input.startDate : null,
          completedAt: input.status === EventStatus.COMPLETED ? input.endDate : null,
          cancelledAt: input.status === EventStatus.CANCELLED ? new Date('2026-08-01T12:00:00.000Z') : null,
          organizer: must(users, input.organizerKey),
          vendors: input.slug === 'uat-completed-concert' ? [must(vendors, 'vendor-a')] : [],
          capacity: input.capacity,
          gallery: [],
          creationProgress: published
            ? { currentStep: 6, completedSteps: [1, 2, 3, 4, 5, 6], skippedSteps: [], lastSavedAt: new Date() }
            : { currentStep: 3, completedSteps: [1, 2], skippedSteps: [], lastSavedAt: new Date() },
        },
      },
      UPSERT,
    );
    events.set(input.slug, event._id);
    for (const ticket of input.ticketTypes) {
      const ticketType = await m.ticketType.findOneAndUpdate(
        { event: event._id, name: ticket.name },
        { $set: { price: ticket.price, quantity: ticket.quantity, isFree: ticket.isFree, description: 'Billet fictif de recette.' } },
        UPSERT,
      );
      ticketTypes.set(`${input.slug}:${ticket.name}`, ticketType._id);
    }
  }

  // Billets utilisés sur l'événement terminé : rendent les avis participants vérifiables.
  const completed = must(events, 'uat-completed-concert');
  const completedFree = must(ticketTypes, `uat-completed-concert:${FREE_TICKET.name}`);
  for (const key of ['participant-a', 'participant-b']) {
    const buyerId = must(users, key);
    await m.ticket.findOneAndUpdate(
      { event: completed, buyerId, ticketType: completedFree },
      { $set: { price: 0, status: TicketPurchaseStatus.USED, scannedAt: new Date('2026-05-15T23:30:00.000Z') } },
      UPSERT,
    );
  }
  // Recalcule `sold` à partir des billets réels : invariant sold + reserved <= quantity.
  await m.ticketType.updateOne(
    { _id: completedFree },
    { $set: { sold: await m.ticket.countDocuments({ ticketType: completedFree, status: { $in: [TicketPurchaseStatus.VALID, TicketPurchaseStatus.USED] } }) } },
  );

  await m.registration.findOneAndUpdate(
    { eventId: must(events, 'uat-unlisted-workshop'), participantId: must(users, 'participant-a') },
    { $set: { status: EventRegistrationStatus.ACTIVE } },
    UPSERT,
  );

  const privateGala = must(events, 'uat-private-gala');
  const organizerA = must(users, 'organizer-a');
  const guests = [
    { name: 'Bruno Participant', email: `participant.b@${UAT_EMAIL_DOMAIN}`, status: GuestStatus.CONFIRMED },
    { name: 'Invité Externe', email: `guest.external@${UAT_EMAIL_DOMAIN}`, status: GuestStatus.INVITED },
    { name: 'Invitée Déclinée', email: `guest.declined@${UAT_EMAIL_DOMAIN}`, status: GuestStatus.DECLINED },
  ];
  for (const guest of guests) {
    await m.guest.findOneAndUpdate(
      { event: privateGala, email: guest.email },
      { $set: { name: guest.name, status: guest.status, addedBy: organizerA, note: 'Invité fictif de recette.' } },
      UPSERT,
    );
  }

  // Invitations : le jeton brut n'est ni stocké ni affiché (seul son hash l'est, comme en production).
  const invitations = [
    { email: `participant.b@${UAT_EMAIL_DOMAIN}`, name: 'Bruno Participant', type: InvitationType.PARTICIPANT, eventId: privateGala },
    { email: `new.vendor@${UAT_EMAIL_DOMAIN}`, name: 'Nouveau Prestataire', type: InvitationType.VENDOR, eventId: null, category: VendorCategory.DJ },
  ];
  for (const invitation of invitations) {
    const rawToken = randomBytes(32).toString('base64url');
    await m.invitation.findOneAndUpdate(
      { invitedBy: organizerA, email: invitation.email, eventId: invitation.eventId, type: invitation.type },
      {
        $set: { name: invitation.name, ...(invitation.category ? { category: invitation.category } : {}) },
        $setOnInsert: {
          status: InvitationStatus.PENDING,
          tokenHash: createHash('sha256').update(rawToken).digest('hex'),
          tokenPrefix: rawToken.slice(0, 8),
        },
      },
      UPSERT,
    );
  }

  const vendorA = must(vendors, 'vendor-a');
  const vendorRequest = await m.vendorRequest.findOneAndUpdate(
    { event: completed, vendor: vendorA, organizer: organizerA },
    { $set: { status: VendorRequestStatus.ACCEPTED, message: 'Couverture photo (UAT).', respondedAt: new Date('2026-04-20T12:00:00.000Z') } },
    UPSERT,
  );
  const venueAlpha = must(venues, 'UAT Salle Alpha');
  const booking = await m.booking.findOneAndUpdate(
    { event: completed, venue: venueAlpha, organizer: organizerA },
    {
      $set: {
        bookingStart: new Date('2026-05-15T20:00:00.000Z'),
        bookingEnd: new Date('2026-05-16T05:00:00.000Z'),
        status: VenueBookingStatus.CONFIRMED,
        totalPrice: 1500,
        respondedAt: new Date('2026-04-22T12:00:00.000Z'),
      },
    },
    UPSERT,
  );

  const reviews = [
    { author: must(users, 'participant-a'), targetType: ReviewTargetType.EVENT, targetId: completed, contextType: ReviewContextType.EVENT, contextId: completed, direction: ReviewDirection.PARTICIPANT_EVENT, rating: 5, comment: 'Très belle soirée (avis fictif UAT).' },
    { author: must(users, 'participant-b'), targetType: ReviewTargetType.EVENT, targetId: completed, contextType: ReviewContextType.EVENT, contextId: completed, direction: ReviewDirection.PARTICIPANT_EVENT, rating: 4, comment: 'Bonne organisation (avis fictif UAT).' },
    { author: organizerA, targetType: ReviewTargetType.VENDOR, targetId: vendorA, contextType: ReviewContextType.VENDOR_REQUEST, contextId: vendorRequest._id, direction: ReviewDirection.ORGANIZER_VENDOR, rating: 5, comment: 'Photographe ponctuel (avis fictif UAT).' },
    { author: organizerA, targetType: ReviewTargetType.VENUE, targetId: venueAlpha, contextType: ReviewContextType.VENUE_BOOKING, contextId: booking._id, direction: ReviewDirection.ORGANIZER_VENUE, rating: 4, comment: 'Salle bien équipée (avis fictif UAT).' },
  ];
  for (const review of reviews) {
    const { author, contextType, contextId, direction, ...fields } = review;
    // Clé = index unique `review_verified_context_unique` ; champs immuables posés à l'insertion via le filtre.
    await m.review.findOneAndUpdate(
      { schemaVersion: 2, author, contextType, contextId, direction },
      { $set: fields, $setOnInsert: { verifiedAt: new Date('2026-05-20T12:00:00.000Z') } },
      UPSERT,
    );
  }

  const counts: Record<string, number> = {};
  for (const [name, model] of Object.entries(m)) {
    counts[name] = await (model as mongoose.Model<unknown>).countDocuments({});
  }
  return {
    accounts: UAT_ACCOUNTS.map((item) => ({ email: item.email, roles: item.roles.join(','), verified: item.verified, purpose: item.purpose })),
    counts,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function resolveUatConnection(env: NodeJS.ProcessEnv): { uri: string; clusterHost: string; target: GuardedTarget } {
  const uri = env.MONGODB_URI;
  if (!uri) throw new ScriptGuardError('MONGODB_URI_REQUIRED', 'aucune connexion tentée');
  const described = describeMongoUri(uri);
  const target = assertUatTarget(env.ELINTYS_ENV, described.databaseName);
  return { uri, clusterHost: described.clusterHost, target };
}

export async function connectUat(uri: string, target: GuardedTarget): Promise<Connection> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000, autoIndex: false });
  assertConnectedDatabase(target, mongoose.connection.db?.databaseName);
  return mongoose.connection;
}

export function printSeedSummary(summary: UatSeedSummary): void {
  console.log('Comptes UAT (mot de passe : valeur de UAT_SEED_PASSWORD, jamais affichée) :');
  console.table(summary.accounts);
  console.table(summary.counts);
}

async function main(argv: readonly string[]): Promise<void> {
  const flags = parseCliFlags(argv, ['env-file']);
  requireExplicitEnvFile(flagValue(flags, 'env-file'), 'uat');
  const { uri, clusterHost, target } = resolveUatConnection(process.env);
  const password = assertSeedPassword(process.env[UAT_SEED_PASSWORD_ENV]);
  console.log(`[seed:uat] cible : cluster=${clusterHost} base=${target.databaseName}`);
  const connection = await connectUat(uri, target);
  try {
    printSeedSummary(await seedUatDatabase(connection, password));
    console.log('[seed:uat] terminé (idempotent, aucune suppression).');
  } finally {
    await mongoose.disconnect();
  }
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[seed:uat] ÉCHEC ${formatSafeError(error)}`);
    process.exitCode = 1;
  });
}
