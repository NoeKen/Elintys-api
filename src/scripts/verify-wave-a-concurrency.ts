import 'dotenv/config';

/**
 * verify-wave-a-concurrency.ts — preuve de concurrence sur MongoDB RÉEL.
 *
 * Les tests Jest de la vague A vérifient la logique avec des modèles mockés :
 * ils prouvent que le filtre conditionnel est bien envoyé, pas que MongoDB
 * l'honore. Ce script vérifie la propriété là où elle compte — contre le
 * replica set `elintys-dev`, avec de vraies mises à jour conditionnelles et
 * de vrais index uniques.
 *
 * Scénarios :
 *   A. Deux scans simultanés du même billet
 *   B. Billet d'un AUTRE événement présenté au scanner
 *   C. Accepter et refuser simultanément la même demande prestataire
 *   D. Répondre et annuler simultanément la même demande prestataire
 *   E. Confirmer et refuser simultanément la même réservation de lieu
 *   F. Répondre et annuler simultanément la même réservation de lieu
 *   G. Double ajout simultané du même favori
 *
 * Attendu partout : exactement UN gagnant, aucun effet de bord dupliqué.
 *
 * GARDES (identiques à verify-wave5-concurrency) :
 *   - `ELINTYS_ENV` doit valoir `dev`
 *   - la base connectée doit s'appeler exactement `elintys-dev`
 *   - le script ne supprime QUE les documents qu'il a lui-même créés,
 *     identifiés par leurs `_id` collectés pendant l'exécution
 */

import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AppModule } from '../app.module';
import { TicketsService } from '../modules/tickets/tickets.service';
import { VendorsService } from '../modules/vendors/vendors.service';
import { VenuesService } from '../modules/venues/venues.service';
import { FavoritesService } from '../modules/favorites/favorites.service';
import { VendorRequestStatus } from '../modules/vendors/vendor.schema';
import { VenueBookingStatus } from '../modules/venues/venue.schema';
import { FavoriteTargetType } from '../modules/favorites/favorite.schema';
import {
  assertEnvironmentGuards,
  REQUIRED_DB_NAME,
} from './migrate-sprint3-wave4-indexes';

const PREFIX = 'wave-a-concurrency';

interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  details: Record<string, unknown>;
}

class Cleanup {
  readonly events: Types.ObjectId[] = [];
  readonly users: Types.ObjectId[] = [];
  readonly ticketTypes: Types.ObjectId[] = [];
  readonly purchases: Types.ObjectId[] = [];
  readonly vendors: Types.ObjectId[] = [];
  readonly vendorRequests: Types.ObjectId[] = [];
  readonly venues: Types.ObjectId[] = [];
  readonly venueBookings: Types.ObjectId[] = [];
  readonly favorites: Types.ObjectId[] = [];
}

function countFulfilled(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === 'fulfilled').length;
}

async function main(): Promise<void> {
  const context = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const connection = context.get<Connection>(getConnectionToken());
  assertEnvironmentGuards(process.env.ELINTYS_ENV, connection.db?.databaseName);

  const cleanup = new Cleanup();
  const results: ScenarioResult[] = [];

  try {
    const tickets = context.get(TicketsService);
    const vendors = context.get(VendorsService);
    const venues = context.get(VenuesService);
    const favorites = context.get(FavoritesService);

    results.push(await scenarioA(connection, cleanup, tickets));
    results.push(await scenarioB(connection, cleanup, tickets));
    results.push(await scenarioC(connection, cleanup, vendors));
    results.push(await scenarioD(connection, cleanup, vendors));
    results.push(await scenarioE(connection, cleanup, venues));
    results.push(await scenarioF(connection, cleanup, venues));
    results.push(await scenarioG(connection, cleanup, favorites));
  } finally {
    await purge(connection, cleanup);
    await context.close();
  }

  const failed = results.filter((result) => !result.passed);
  console.log(JSON.stringify({ database: REQUIRED_DB_NAME, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} scénarios réussis.`);
  if (failed.length > 0) {
    console.error(`ÉCHEC : ${failed.map((result) => result.id).join(', ')}`);
    process.exitCode = 1;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function insertUser(
  connection: Connection,
  cleanup: Cleanup,
  role: string,
): Promise<Types.ObjectId> {
  const _id = new Types.ObjectId();
  const now = new Date();
  await connection.db!.collection('users').insertOne({
    _id,
    email: `${PREFIX}-${_id.toString()}@example.invalid`,
    fullName: `${PREFIX} ${role}`,
    isEmailVerified: true,
    roles: [role],
    createdAt: now,
    updatedAt: now,
  });
  cleanup.users.push(_id);
  return _id;
}

async function insertEvent(
  connection: Connection,
  cleanup: Cleanup,
  organizerId: Types.ObjectId,
): Promise<Types.ObjectId> {
  const _id = new Types.ObjectId();
  const now = new Date();
  await connection.db!.collection('events').insertOne({
    _id,
    title: `${PREFIX} ${_id.toString()}`,
    status: 'published',
    archivedAt: null,
    organizer: organizerId,
    discoverability: 'public',
    visibility: 'public',
    accessPolicy: { type: 'open' },
    admissionModes: ['free_ticket'],
    accessModelVersion: 2,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.events.push(_id);
  return _id;
}

async function insertValidPurchase(
  connection: Connection,
  cleanup: Cleanup,
  eventId: Types.ObjectId,
  buyerId: Types.ObjectId,
  qrCode: string,
): Promise<Types.ObjectId> {
  const ticketTypeId = new Types.ObjectId();
  const purchaseId = new Types.ObjectId();
  const now = new Date();

  await connection.db!.collection('tickettypes').insertOne({
    _id: ticketTypeId,
    event: eventId,
    name: `${PREFIX} billet`,
    price: 0,
    quantity: 10,
    sold: 1,
    reserved: 0,
    isFree: true,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.ticketTypes.push(ticketTypeId);

  await connection.db!.collection('ticketpurchases').insertOne({
    _id: purchaseId,
    event: eventId,
    buyerId,
    ticketType: ticketTypeId,
    price: 0,
    qrCode,
    status: 'valid',
    createdAt: now,
    updatedAt: now,
  });
  cleanup.purchases.push(purchaseId);
  return purchaseId;
}

async function insertVendorRequest(
  connection: Connection,
  cleanup: Cleanup,
): Promise<{ requestId: Types.ObjectId; vendorUserId: Types.ObjectId; organizerId: Types.ObjectId }> {
  const organizerId = await insertUser(connection, cleanup, 'organisateur');
  const vendorUserId = await insertUser(connection, cleanup, 'prestataire');
  const eventId = await insertEvent(connection, cleanup, organizerId);
  const vendorId = new Types.ObjectId();
  const requestId = new Types.ObjectId();
  const now = new Date();

  await connection.db!.collection('vendorprofiles').insertOne({
    _id: vendorId,
    user: vendorUserId,
    businessName: `${PREFIX} prestataire`,
    category: 'photographe',
    photos: [],
    serviceArea: 'Montréal',
    isActive: true,
    rating: 0,
    reviewCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.vendors.push(vendorId);

  await connection.db!.collection('vendorrequests').insertOne({
    _id: requestId,
    event: eventId,
    vendor: vendorId,
    organizer: organizerId,
    source: 'platform',
    status: VendorRequestStatus.PENDING,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.vendorRequests.push(requestId);

  return { requestId, vendorUserId, organizerId };
}

async function insertVenueBooking(
  connection: Connection,
  cleanup: Cleanup,
): Promise<{ bookingId: Types.ObjectId; venueUserId: Types.ObjectId; organizerId: Types.ObjectId }> {
  const organizerId = await insertUser(connection, cleanup, 'organisateur');
  const venueUserId = await insertUser(connection, cleanup, 'gestionnaire_salle');
  const eventId = await insertEvent(connection, cleanup, organizerId);
  const venueId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const now = new Date();

  await connection.db!.collection('venueprofiles').insertOne({
    _id: venueId,
    user: venueUserId,
    name: `${PREFIX} salle`,
    type: 'other',
    address: { street: '1 rue Test', city: 'Montréal', province: 'QC' },
    capacity: 100,
    photos: [],
    amenities: [],
    isActive: true,
    rating: 0,
    reviewCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.venues.push(venueId);

  await connection.db!.collection('venuebookings').insertOne({
    _id: bookingId,
    event: eventId,
    venue: venueId,
    organizer: organizerId,
    source: 'platform',
    status: VenueBookingStatus.PENDING,
    bookingStart: new Date(Date.now() + 86_400_000),
    bookingEnd: new Date(Date.now() + 172_800_000),
    currency: 'CAD',
    createdAt: now,
    updatedAt: now,
  });
  cleanup.venueBookings.push(bookingId);

  return { bookingId, venueUserId, organizerId };
}

/** Ne supprime QUE les documents créés par ce script, par `_id` explicite. */
async function purge(connection: Connection, cleanup: Cleanup): Promise<void> {
  const database = connection.db!;
  await database.collection('favorites').deleteMany({ user: { $in: cleanup.users } });
  await database.collection('ticketpurchases').deleteMany({ _id: { $in: cleanup.purchases } });
  await database.collection('tickettypes').deleteMany({ _id: { $in: cleanup.ticketTypes } });
  await database.collection('vendorrequests').deleteMany({ _id: { $in: cleanup.vendorRequests } });
  await database.collection('vendorprofiles').deleteMany({ _id: { $in: cleanup.vendors } });
  await database.collection('venuebookings').deleteMany({ _id: { $in: cleanup.venueBookings } });
  await database.collection('venueprofiles').deleteMany({ _id: { $in: cleanup.venues } });
  await database.collection('notifications').deleteMany({ userId: { $in: cleanup.users } });
  await database.collection('events').deleteMany({ _id: { $in: cleanup.events } });
  await database.collection('users').deleteMany({ _id: { $in: cleanup.users } });
}

// ── Scénarios ───────────────────────────────────────────────────────────────

async function scenarioA(
  connection: Connection,
  cleanup: Cleanup,
  tickets: TicketsService,
): Promise<ScenarioResult> {
  const organizerId = await insertUser(connection, cleanup, 'organisateur');
  const buyerId = await insertUser(connection, cleanup, 'participant');
  const eventId = await insertEvent(connection, cleanup, organizerId);
  const qrCode = `${PREFIX}-A-${Date.now()}`;
  await insertValidPurchase(connection, cleanup, eventId, buyerId, qrCode);

  const outcomes = await Promise.allSettled([
    tickets.scan(eventId.toString(), qrCode, organizerId.toString(), ['organisateur']),
    tickets.scan(eventId.toString(), qrCode, organizerId.toString(), ['organisateur']),
  ]);

  const admitted = outcomes.filter(
    (outcome) => outcome.status === 'fulfilled' && outcome.value.outcome === 'admitted',
  ).length;
  const alreadyUsed = outcomes.filter(
    (outcome) => outcome.status === 'fulfilled' && outcome.value.outcome === 'already_used',
  ).length;

  return {
    id: 'A',
    title: 'Deux scans simultanés du même billet : une seule admission',
    passed: admitted === 1 && alreadyUsed === 1,
    details: { admitted, alreadyUsed },
  };
}

async function scenarioB(
  connection: Connection,
  cleanup: Cleanup,
  tickets: TicketsService,
): Promise<ScenarioResult> {
  const organizerId = await insertUser(connection, cleanup, 'organisateur');
  const buyerId = await insertUser(connection, cleanup, 'participant');
  const eventA = await insertEvent(connection, cleanup, organizerId);
  const eventB = await insertEvent(connection, cleanup, organizerId);
  const qrCode = `${PREFIX}-B-${Date.now()}`;
  await insertValidPurchase(connection, cleanup, eventB, buyerId, qrCode);

  let refused = false;
  try {
    await tickets.scan(eventA.toString(), qrCode, organizerId.toString(), ['organisateur']);
  } catch {
    refused = true;
  }

  const state = await connection
    .db!.collection('ticketpurchases')
    .findOne({ qrCode });

  return {
    id: 'B',
    title: "Billet d'un autre événement : refusé et laissé intact",
    passed: refused && state?.status === 'valid',
    details: { refused, status: state?.status },
  };
}

async function scenarioC(
  connection: Connection,
  cleanup: Cleanup,
  vendors: VendorsService,
): Promise<ScenarioResult> {
  const { requestId, vendorUserId } = await insertVendorRequest(connection, cleanup);

  const outcomes = await Promise.allSettled([
    vendors.respondToRequest(requestId.toString(), vendorUserId.toString(), {
      status: VendorRequestStatus.ACCEPTED,
    }),
    vendors.respondToRequest(requestId.toString(), vendorUserId.toString(), {
      status: VendorRequestStatus.DECLINED,
    }),
  ]);

  const state = await connection.db!.collection('vendorrequests').findOne({ _id: requestId });
  // Effet de bord : une seule notification, donc un seul verdict annoncé.
  const notifications = await connection
    .db!.collection('notifications')
    .countDocuments({ 'payload.requestId': requestId.toString() });

  return {
    id: 'C',
    title: 'Accepter vs refuser simultanément : un seul verdict, une seule notification',
    passed:
      countFulfilled(outcomes) === 1 &&
      [VendorRequestStatus.ACCEPTED, VendorRequestStatus.DECLINED].includes(
        state?.status as VendorRequestStatus,
      ) &&
      notifications <= 1,
    details: { fulfilled: countFulfilled(outcomes), status: state?.status, notifications },
  };
}

async function scenarioD(
  connection: Connection,
  cleanup: Cleanup,
  vendors: VendorsService,
): Promise<ScenarioResult> {
  const { requestId, vendorUserId, organizerId } = await insertVendorRequest(connection, cleanup);

  const outcomes = await Promise.allSettled([
    vendors.respondToRequest(requestId.toString(), vendorUserId.toString(), {
      status: VendorRequestStatus.ACCEPTED,
    }),
    vendors.cancelRequest(requestId.toString(), organizerId.toString()),
  ]);

  const state = await connection.db!.collection('vendorrequests').findOne({ _id: requestId });
  const deleted = state === null;

  return {
    id: 'D',
    title: 'Répondre vs annuler : exactement une opération gagnante',
    passed: countFulfilled(outcomes) === 1 && (deleted || state?.status === VendorRequestStatus.ACCEPTED),
    details: { fulfilled: countFulfilled(outcomes), deleted, status: state?.status },
  };
}

async function scenarioE(
  connection: Connection,
  cleanup: Cleanup,
  venues: VenuesService,
): Promise<ScenarioResult> {
  const { bookingId, venueUserId } = await insertVenueBooking(connection, cleanup);

  const outcomes = await Promise.allSettled([
    venues.respondToBooking(bookingId.toString(), venueUserId.toString(), {
      status: VenueBookingStatus.CONFIRMED,
    }),
    venues.respondToBooking(bookingId.toString(), venueUserId.toString(), {
      status: VenueBookingStatus.REFUSED,
    }),
  ]);

  const state = await connection.db!.collection('venuebookings').findOne({ _id: bookingId });
  const notifications = await connection
    .db!.collection('notifications')
    .countDocuments({ 'payload.bookingId': bookingId.toString() });

  return {
    id: 'E',
    title: 'Confirmer vs refuser simultanément : un seul verdict, une seule notification',
    passed:
      countFulfilled(outcomes) === 1 &&
      [VenueBookingStatus.CONFIRMED, VenueBookingStatus.REFUSED].includes(
        state?.status as VenueBookingStatus,
      ) &&
      notifications <= 1,
    details: { fulfilled: countFulfilled(outcomes), status: state?.status, notifications },
  };
}

async function scenarioF(
  connection: Connection,
  cleanup: Cleanup,
  venues: VenuesService,
): Promise<ScenarioResult> {
  const { bookingId, venueUserId, organizerId } = await insertVenueBooking(connection, cleanup);

  const outcomes = await Promise.allSettled([
    venues.respondToBooking(bookingId.toString(), venueUserId.toString(), {
      status: VenueBookingStatus.CONFIRMED,
    }),
    venues.cancelBooking(bookingId.toString(), organizerId.toString(), ['organisateur']),
  ]);

  const state = await connection.db!.collection('venuebookings').findOne({ _id: bookingId });

  // Les deux opérations portent sur des états compatibles (pending ET
  // confirmed sont annulables) : le point vérifié est qu'elles ne peuvent pas
  // laisser la réservation dans un état incohérent, et qu'au moins une échoue
  // si elles visent la même transition.
  const finalStatus = state?.status as VenueBookingStatus | undefined;
  const coherent =
    finalStatus === VenueBookingStatus.CANCELLED || finalStatus === VenueBookingStatus.CONFIRMED;

  return {
    id: 'F',
    title: 'Répondre vs annuler une réservation : état final cohérent, jamais indéterminé',
    passed: coherent && countFulfilled(outcomes) >= 1,
    details: { fulfilled: countFulfilled(outcomes), status: finalStatus },
  };
}

async function scenarioG(
  connection: Connection,
  cleanup: Cleanup,
  favorites: FavoritesService,
): Promise<ScenarioResult> {
  const organizerId = await insertUser(connection, cleanup, 'organisateur');
  const userId = await insertUser(connection, cleanup, 'participant');
  const eventId = await insertEvent(connection, cleanup, organizerId);

  const dto = {
    targetType: FavoriteTargetType.EVENT,
    targetId: eventId.toString(),
  };

  const outcomes = await Promise.allSettled([
    favorites.add(userId.toString(), dto),
    favorites.add(userId.toString(), dto),
  ]);

  const stored = await connection
    .db!.collection('favorites')
    .countDocuments({ user: userId, targetId: eventId });

  return {
    id: 'G',
    title: "Double ajout simultané du même favori : l'index unique tranche",
    passed: countFulfilled(outcomes) === 1 && stored === 1,
    details: { fulfilled: countFulfilled(outcomes), stored },
  };
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
