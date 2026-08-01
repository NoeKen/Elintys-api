import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import mongoose, { Model, Types } from 'mongoose';
import {
  User,
  UserRole,
  UserSchema,
} from '../modules/auth/user.schema';
import {
  Event,
  EventLocationType,
  EventSchema,
  EventStatus,
  EventType,
  EventVisibility,
  EventDiscoverability,
  EventAccessPolicyType,
  AdmissionMode,
  VenueMode,
} from '../modules/events/event.schema';
import {
  VendorCategory,
  VendorProfile,
  VendorProfileSchema,
} from '../modules/vendors/vendor.schema';
import {
  VenueProfile,
  VenueProfileSchema,
  VenueType,
} from '../modules/venues/venue.schema';
import {
  ElintysEnvironment,
  resolveElintysEnvironment,
} from '../config/elintys-environment';

const DEV_DATABASE_NAME = 'elintys-dev';
const DEMO_PASSWORD = 'Elintys-Dev-2026!';

export function assertDevelopmentSeedAllowed(
  elintysEnvironment: ElintysEnvironment,
  mongoUri: string | undefined,
): asserts mongoUri is string {
  if (elintysEnvironment !== 'dev') {
    throw new Error('SEED_REFUSED: ELINTYS_ENV must be exactly "dev".');
  }
  if (!mongoUri) {
    throw new Error('SEED_REFUSED: MONGODB_URI is required.');
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(mongoUri).pathname.slice(1));
  } catch {
    throw new Error('SEED_REFUSED: MONGODB_URI is invalid.');
  }
  if (databaseName !== DEV_DATABASE_NAME) {
    throw new Error(
      `SEED_REFUSED: database must be exactly "${DEV_DATABASE_NAME}".`,
    );
  }
}

interface DemoUserInput {
  key: string;
  fullName: string;
  email: string;
  roles: UserRole[];
}

const DEMO_USERS: DemoUserInput[] = [
  {
    key: 'organizer',
    fullName: 'Olivia Organisatrice',
    email: 'organisateur@demo.elintys.com',
    roles: [UserRole.ORGANISATEUR],
  },
  {
    key: 'vendor-photographer',
    fullName: 'Philippe Photographe',
    email: 'prestataire@demo.elintys.com',
    roles: [UserRole.PRESTATAIRE],
  },
  {
    key: 'venue-manager',
    fullName: 'Gabrielle Gestionnaire',
    email: 'gestionnaire@demo.elintys.com',
    roles: [UserRole.GESTIONNAIRE_SALLE],
  },
  {
    key: 'participant',
    fullName: 'Patrice Participant',
    email: 'participant@demo.elintys.com',
    roles: [UserRole.PARTICIPANT],
  },
  ...[
    ['vendor-catering', 'Théo Traiteur', 'traiteur'],
    ['vendor-dj', 'Diane DJ', 'dj'],
    ['vendor-decorator', 'Déborah Décoratrice', 'decorateur'],
    ['vendor-host', 'Alex Animateur', 'animateur'],
    ['vendor-sound', 'Sonia Sonorisation', 'sonorisation'],
    ['vendor-video', 'Victor Vidéaste', 'video'],
    ['vendor-floral', 'Flora Fleuriste', 'fleuriste'],
    ['vendor-pastry', 'Camille Pâtissière', 'patisserie'],
    ['vendor-lighting', 'Luc Éclairagiste', 'eclairage'],
    ['venue-rooftop', 'Roxane Rooftop', 'rooftop'],
    ['venue-studio', 'Stéphane Studio', 'studio'],
    ['venue-conference', 'Constance Conférence', 'conference'],
    ['venue-restaurant', 'Rémi Restaurant', 'restaurant'],
    ['venue-spectacle', 'Salomé Spectacle', 'spectacle'],
    ['venue-loft', 'Léa Loft', 'loft'],
    ['venue-garden', 'Jade Jardin', 'jardin'],
    ['venue-gallery', 'Gaëlle Galerie', 'galerie'],
    ['venue-hotel', 'Hugo Hôtel', 'hotel'],
  ].map(([key, fullName, slug]) => ({
    key,
    fullName,
    email: `${slug}@demo.elintys.com`,
    roles: [
      key.startsWith('venue-')
        ? UserRole.GESTIONNAIRE_SALLE
        : UserRole.PRESTATAIRE,
    ],
  })),
];

async function upsertUsers(
  userModel: Model<User>,
): Promise<Map<string, Types.ObjectId>> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const ids = new Map<string, Types.ObjectId>();

  for (const input of DEMO_USERS) {
    const user = await userModel.findOneAndUpdate(
      { email: input.email },
      {
        $set: {
          fullName: input.fullName,
          roles: input.roles,
          password: passwordHash,
          isEmailVerified: true,
          onboardingCompleted: true,
          onboardingByRole: Object.fromEntries(
            input.roles.map((role) => [role, true]),
          ),
        },
        $setOnInsert: {
          referralBalance: 0,
          subscriptions: [],
          onboardingData: {},
        },
        $unset: {
          emailVerificationToken: 1,
          emailVerificationExpiresAt: 1,
          passwordResetToken: 1,
          passwordResetExpires: 1,
          refreshToken: 1,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    ids.set(input.key, user._id);
  }

  return ids;
}

function requireId(ids: Map<string, Types.ObjectId>, key: string): Types.ObjectId {
  const id = ids.get(key);
  if (!id) throw new Error(`SEED_INVARIANT_FAILED: missing user "${key}".`);
  return id;
}

async function upsertVendors(
  vendorModel: Model<VendorProfile>,
  userIds: Map<string, Types.ObjectId>,
): Promise<Types.ObjectId[]> {
  const inputs = [
    {
      userKey: 'vendor-photographer',
      businessName: 'Lumière Nord',
      category: VendorCategory.PHOTOGRAPHE,
      description: 'Photographie éditoriale et événementielle à Montréal.',
      priceRange: { min: 850, max: 3200, currency: 'CAD' },
      serviceArea: 'Grand Montréal, Laval et Longueuil',
      rating: 4.9,
      reviewCount: 47,
    },
    {
      userKey: 'vendor-catering',
      businessName: 'Maison Papille',
      category: VendorCategory.TRAITEUR,
      description: 'Menus locaux et service traiteur pour réceptions.',
      priceRange: { min: 1800, max: 9000, currency: 'CAD' },
      serviceArea: 'Montréal et Rive-Sud',
      rating: 4.8,
      reviewCount: 31,
    },
    {
      userKey: 'vendor-dj',
      businessName: 'Onde Nocturne',
      category: VendorCategory.DJ,
      description: 'DJ, sonorisation et ambiance musicale sur mesure.',
      priceRange: { min: 2800, max: 6500, currency: 'CAD' },
      serviceArea: 'Grand Montréal et Québec',
      rating: 4.7,
      reviewCount: 62,
    },
    {
      userKey: 'vendor-decorator',
      businessName: 'Atelier Éclat',
      category: VendorCategory.DECORATEUR,
      description: 'Direction artistique florale et scénographie.',
      priceRange: { min: 6200, max: 18000, currency: 'CAD' },
      serviceArea: 'Montréal, Laval et Longueuil',
      rating: 4.9,
      reviewCount: 24,
    },
    {
      userKey: 'vendor-host',
      businessName: 'Micro Ouvert',
      category: VendorCategory.ANIMATEUR,
      description: 'Animation bilingue de galas et événements corporatifs.',
      priceRange: { min: 1200, max: 3500, currency: 'CAD' },
      serviceArea: 'Québec et Grand Montréal',
      rating: 4.6,
      reviewCount: 18,
    },
    {
      userKey: 'vendor-sound',
      businessName: 'Résonance Pro',
      category: VendorCategory.SONORISATION,
      description: 'Sonorisation, micros et régie technique événementielle.',
      priceRange: { min: 2400, max: 11000, currency: 'CAD' },
      serviceArea: 'Montréal, Laval et Longueuil',
      rating: 4.8,
      reviewCount: 29,
    },
    {
      userKey: 'vendor-video',
      businessName: 'Mouvement Studio',
      category: VendorCategory.AUTRE,
      description: 'Captation vidéo et diffusion en direct.',
      priceRange: { min: 3500, max: 14000, currency: 'CAD' },
      serviceArea: 'Grand Montréal et Québec',
      rating: 4.7,
      reviewCount: 22,
    },
    {
      userKey: 'vendor-floral',
      businessName: 'Flore Locale',
      category: VendorCategory.DECORATEUR,
      description: 'Design floral durable pour événements privés et corporatifs.',
      priceRange: { min: 950, max: 7500, currency: 'CAD' },
      serviceArea: 'Montréal et Rive-Sud',
      rating: 4.9,
      reviewCount: 41,
    },
    {
      userKey: 'vendor-pastry',
      businessName: 'Sucre Atelier',
      category: VendorCategory.TRAITEUR,
      description: 'Pâtisserie sur mesure et tables gourmandes.',
      priceRange: { min: 650, max: 4200, currency: 'CAD' },
      serviceArea: 'Montréal, Laval et Longueuil',
      rating: 4.6,
      reviewCount: 33,
    },
    {
      userKey: 'vendor-lighting',
      businessName: 'Lueur Scénique',
      category: VendorCategory.SONORISATION,
      description: 'Éclairage architectural et scénographique.',
      priceRange: { min: 5400, max: 20000, currency: 'CAD' },
      serviceArea: 'Québec et Grand Montréal',
      rating: 4.8,
      reviewCount: 17,
    },
  ];

  const ids: Types.ObjectId[] = [];
  for (const input of inputs) {
    const { userKey, ...profile } = input;
    const user = requireId(userIds, userKey);
    const vendor = await vendorModel.findOneAndUpdate(
      { user },
      {
        $set: {
          ...profile,
          user,
          photos: [],
          isActive: true,
          isPremium: profile.rating >= 4.9,
          contactEmail: DEMO_USERS.find((item) => item.key === userKey)?.email,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    ids.push(vendor._id);
  }
  return ids;
}

async function upsertVenues(
  venueModel: Model<VenueProfile>,
  userIds: Map<string, Types.ObjectId>,
): Promise<Types.ObjectId[]> {
  const inputs = [
    {
      userKey: 'venue-manager',
      name: 'Maison Saint-Laurent',
      type: VenueType.RECEPTION,
      description: 'Espace lumineux au cœur du Vieux-Montréal.',
      address: {
        street: '125 rue Saint-Paul Ouest',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H2Y 1Z5',
      },
      capacity: 280,
      amenities: ['Cuisine', 'Vestiaire', 'Accessibilité', 'Wi-Fi'],
      pricePerDay: 4800,
      rating: 4.9,
      reviewCount: 36,
    },
    {
      userKey: 'venue-rooftop',
      name: 'Terrasse Boréale',
      type: VenueType.ROOFTOP,
      description: 'Rooftop avec vue panoramique sur Montréal.',
      address: {
        street: '800 boulevard René-Lévesque',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H3B 1X9',
      },
      capacity: 140,
      amenities: ['Bar', 'Sonorisation', 'Vue panoramique'],
      pricePerDay: 3900,
      rating: 4.7,
      reviewCount: 21,
    },
    {
      userKey: 'venue-studio',
      name: 'Studio du Canal',
      type: VenueType.STUDIO,
      description: 'Studio modulable pour lancements et ateliers.',
      address: {
        street: '2100 rue du Centre',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H3K 1J4',
      },
      capacity: 80,
      amenities: ['Éclairage', 'Projecteur', 'Wi-Fi'],
      pricePerDay: 1800,
      rating: 4.6,
      reviewCount: 14,
    },
    {
      userKey: 'venue-conference',
      name: 'Forum du Mile End',
      type: VenueType.CONFERENCE,
      description: 'Salle équipée pour conférences et formations.',
      address: {
        street: '5555 avenue de Gaspé',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H2T 2A3',
      },
      capacity: 320,
      amenities: ['Projecteur', 'Scène', 'Wi-Fi', 'Accessibilité'],
      pricePerDay: 5200,
      rating: 4.8,
      reviewCount: 28,
    },
    {
      userKey: 'venue-restaurant',
      name: 'Table du Vieux-Port',
      type: VenueType.RESTAURANT,
      description: 'Restaurant privatisable avec cuisine ouverte.',
      address: {
        street: '88 rue de la Commune',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H2Y 2C6',
      },
      capacity: 110,
      amenities: ['Cuisine', 'Bar', 'Terrasse'],
      pricePerDay: 3600,
      rating: 4.7,
      reviewCount: 44,
    },
    {
      userKey: 'venue-spectacle',
      name: 'Théâtre du Parc',
      type: VenueType.SPECTACLE,
      description: 'Salle de spectacle avec scène et régie complète.',
      address: {
        street: '4600 avenue du Parc',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H2V 4E5',
      },
      capacity: 620,
      amenities: ['Scène', 'Loges', 'Sonorisation', 'Éclairage'],
      pricePerDay: 8200,
      rating: 4.9,
      reviewCount: 51,
    },
    {
      userKey: 'venue-loft',
      name: 'Loft Wellington',
      type: VenueType.RECEPTION,
      description: 'Loft industriel pour réceptions et lancements.',
      address: {
        street: '3900 rue Wellington',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H4G 1V3',
      },
      capacity: 190,
      amenities: ['Cuisine', 'Monte-charge', 'Wi-Fi'],
      pricePerDay: 4100,
      rating: 4.6,
      reviewCount: 19,
    },
    {
      userKey: 'venue-garden',
      name: 'Jardin de Laval',
      type: VenueType.RECEPTION,
      description: 'Jardin et pavillon vitré pour célébrations.',
      address: {
        street: '1200 boulevard des Prairies',
        city: 'Laval',
        province: 'QC',
        postalCode: 'H7N 2T5',
      },
      capacity: 240,
      amenities: ['Jardin', 'Stationnement', 'Cuisine'],
      pricePerDay: 5700,
      rating: 4.8,
      reviewCount: 26,
    },
    {
      userKey: 'venue-gallery',
      name: 'Galerie du Quartier',
      type: VenueType.STUDIO,
      description: 'Galerie contemporaine pour cocktails et expositions.',
      address: {
        street: '75 rue Saint-Joseph',
        city: 'Québec',
        province: 'QC',
        postalCode: 'G1K 3A6',
      },
      capacity: 95,
      amenities: ['Éclairage', 'Vestiaire', 'Wi-Fi'],
      pricePerDay: 2300,
      rating: 4.7,
      reviewCount: 12,
    },
    {
      userKey: 'venue-hotel',
      name: 'Salon Laurentien',
      type: VenueType.CONFERENCE,
      description: 'Salon hôtelier modulable pour grands rassemblements.',
      address: {
        street: '1000 boulevard René-Lévesque',
        city: 'Québec',
        province: 'QC',
        postalCode: 'G1R 5T8',
      },
      capacity: 1200,
      amenities: ['Scène', 'Cuisine', 'Wi-Fi', 'Hébergement'],
      pricePerDay: 15000,
      rating: 4.9,
      reviewCount: 63,
    },
  ];

  const ids: Types.ObjectId[] = [];
  for (const input of inputs) {
    const { userKey, ...profile } = input;
    const user = requireId(userIds, userKey);
    const venue = await venueModel.findOneAndUpdate(
      { user },
      {
        $set: {
          ...profile,
          user,
          photos: [],
          isActive: true,
          contactEmail: DEMO_USERS.find((item) => item.key === userKey)?.email,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    ids.push(venue._id);
  }
  return ids;
}

async function upsertEvents(
  eventModel: Model<Event>,
  organizer: Types.ObjectId,
  vendors: Types.ObjectId[],
  venues: Types.ObjectId[],
): Promise<void> {
  const events = [
    {
      slug: 'sommet-innovation-montreal-demo',
      title: 'Sommet Innovation Montréal',
      eventType: EventType.CONFERENCE,
      shortDescription: 'Une journée de rencontres autour des idées qui transforment le Québec.',
      startDate: new Date('2027-04-22T13:00:00.000Z'),
      endDate: new Date('2027-04-22T23:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 0,
      capacity: 250,
    },
    {
      slug: 'gala-horizon-demo',
      title: 'Gala Horizon',
      eventType: EventType.GALA,
      shortDescription: 'Un gala-bénéfice élégant réunissant la communauté créative.',
      startDate: new Date('2027-05-15T22:00:00.000Z'),
      endDate: new Date('2027-05-16T03:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 0,
      capacity: 220,
    },
    {
      slug: 'atelier-marques-vivantes-demo',
      title: 'Atelier Marques Vivantes',
      eventType: EventType.WORKSHOP,
      shortDescription: 'Un atelier pratique pour concevoir des expériences de marque mémorables.',
      startDate: new Date('2027-06-05T14:00:00.000Z'),
      endDate: new Date('2027-06-05T20:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 2,
      capacity: 70,
    },
    {
      slug: 'nuits-du-canal-demo',
      title: 'Nuits du Canal',
      eventType: EventType.CONCERT,
      shortDescription: 'Une soirée musicale intime portée par des artistes locaux.',
      startDate: new Date('2027-07-10T23:00:00.000Z'),
      endDate: new Date('2027-07-11T03:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 2,
      capacity: 75,
    },
    {
      slug: 'reseautage-sur-les-toits-demo',
      title: 'Réseautage sur les toits',
      eventType: EventType.NETWORKING,
      shortDescription: 'Des conversations utiles dans un décor panoramique.',
      startDate: new Date('2027-08-19T21:00:00.000Z'),
      endDate: new Date('2027-08-20T01:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 1,
      capacity: 120,
    },
    {
      slug: 'mariage-jardin-demo',
      title: 'Mariage au Jardin',
      eventType: EventType.WEDDING,
      shortDescription: 'Une célébration estivale dans un jardin lumineux.',
      startDate: new Date('2027-09-04T19:00:00.000Z'),
      endDate: new Date('2027-09-05T03:00:00.000Z'),
      city: 'Laval',
      venueIndex: 7,
      capacity: 180,
    },
    {
      slug: 'festival-creatif-demo',
      title: 'Festival Créatif Québec',
      eventType: EventType.FESTIVAL,
      shortDescription: 'Deux jours de création, de musique et de rencontres.',
      startDate: new Date('2027-09-18T14:00:00.000Z'),
      endDate: new Date('2027-09-19T23:00:00.000Z'),
      city: 'Québec',
      venueIndex: 8,
      capacity: 90,
    },
    {
      slug: 'forum-leadership-demo',
      title: 'Forum Leadership Responsable',
      eventType: EventType.CORPORATE,
      shortDescription: 'Des échanges concrets sur le leadership responsable.',
      startDate: new Date('2027-10-07T13:00:00.000Z'),
      endDate: new Date('2027-10-07T21:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 3,
      capacity: 300,
    },
    {
      slug: 'anniversaire-studio-demo',
      title: 'Anniversaire Studio 360',
      eventType: EventType.BIRTHDAY,
      shortDescription: 'Une expérience immersive pour une soirée mémorable.',
      startDate: new Date('2027-10-23T22:00:00.000Z'),
      endDate: new Date('2027-10-24T03:00:00.000Z'),
      city: 'Montréal',
      venueIndex: 2,
      capacity: 70,
    },
    {
      slug: 'expo-nouvelles-voix-demo',
      title: 'Expo Nouvelles Voix',
      eventType: EventType.OTHER,
      shortDescription: 'Une exposition collective dédiée aux talents émergents.',
      startDate: new Date('2027-11-12T17:00:00.000Z'),
      endDate: new Date('2027-11-13T01:00:00.000Z'),
      city: 'Québec',
      venueIndex: 8,
      capacity: 85,
    },
  ];

  for (const input of events) {
    const venue = venues[input.venueIndex];
    await eventModel.findOneAndUpdate(
      { slug: input.slug },
      {
        $set: {
          title: input.title,
          eventType: input.eventType,
          shortDescription: input.shortDescription,
          description: `${input.shortDescription} Données de démonstration réservées à l’environnement de développement Elintys.`,
          startDate: input.startDate,
          endDate: input.endDate,
          location: {
            type: EventLocationType.PHYSICAL,
            name: input.title,
            city: input.city,
            province: 'Québec',
          },
          timezone: 'America/Toronto',
          venueMode: VenueMode.EXISTING,
          venueProfile: venue,
          visibility: EventVisibility.PUBLIC,
          discoverability: EventDiscoverability.PUBLIC,
          accessPolicy: { type: EventAccessPolicyType.OPEN },
          admissionModes: [AdmissionMode.REGISTRATION_ONLY],
          accessModelVersion: 2,
          status: EventStatus.PUBLISHED,
          organizer,
          vendors: vendors.slice(0, 3),
          capacity: input.capacity,
          gallery: [],
          creationProgress: {
            currentStep: 6,
            completedSteps: [1, 2, 3, 4, 5, 6],
            skippedSteps: [],
            lastSavedAt: new Date(),
          },
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
  }

  await eventModel.findOneAndUpdate(
    { slug: 'festival-rives-draft-demo' },
    {
      $set: {
        title: 'Festival des Rives — brouillon',
        eventType: EventType.FESTIVAL,
        shortDescription: 'Brouillon de démonstration du parcours organisateur.',
        location: {
          type: EventLocationType.PHYSICAL,
          city: 'Longueuil',
          province: 'Québec',
        },
        timezone: 'America/Toronto',
        visibility: EventVisibility.PUBLIC,
        discoverability: EventDiscoverability.UNLISTED,
        accessPolicy: { type: EventAccessPolicyType.REGISTRATION_REQUIRED, requiresAuthentication: true },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
        accessModelVersion: 2,
        status: EventStatus.DRAFT,
        organizer,
        vendors: [],
        gallery: [],
        capacity: 500,
        creationProgress: {
          currentStep: 3,
          completedSteps: [1, 2],
          skippedSteps: [],
          lastSavedAt: new Date(),
        },
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
}

export async function seedDevelopmentDatabase(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;
  const elintysEnvironment = resolveElintysEnvironment(
    process.env.ELINTYS_ENV,
    process.env.NODE_ENV ?? 'development',
  );
  assertDevelopmentSeedAllowed(elintysEnvironment, mongoUri);

  await mongoose.connect(mongoUri);
  try {
    if (mongoose.connection.db?.databaseName !== DEV_DATABASE_NAME) {
      throw new Error('SEED_REFUSED: connected database is not elintys-dev.');
    }

    const userModel = mongoose.connection.model<User>(
      User.name,
      UserSchema,
    );
    const vendorModel = mongoose.connection.model<VendorProfile>(
      VendorProfile.name,
      VendorProfileSchema,
    );
    const venueModel = mongoose.connection.model<VenueProfile>(
      VenueProfile.name,
      VenueProfileSchema,
    );
    const eventModel = mongoose.connection.model<Event>(
      Event.name,
      EventSchema,
    );

    const users = await upsertUsers(userModel);
    const vendors = await upsertVendors(vendorModel, users);
    const venues = await upsertVenues(venueModel, users);
    await upsertEvents(
      eventModel,
      requireId(users, 'organizer'),
      vendors,
      venues,
    );

    await Promise.all([
      userModel.createIndexes(),
      vendorModel.createIndexes(),
      venueModel.createIndexes(),
      eventModel.createIndexes(),
    ]);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  seedDevelopmentDatabase()
    .then(() => {
      console.info('Seed dev Elintys terminé (idempotent, sans suppression).');
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'SEED_FAILED');
      process.exitCode = 1;
    });
}
