import 'dotenv/config';

/**
 * verify-wave5-concurrency.ts — preuve de concurrence sur MongoDB RÉEL.
 *
 * Les tests Jest de la vague vérifient la logique avec un modèle en mémoire.
 * Ce script vérifie la même chose là où ça compte : contre le replica set
 * `elintys-dev`, avec de vraies transactions, de vrais index uniques et de
 * vraies mises à jour conditionnelles.
 *
 * Scénarios exécutés (§21 du cadrage de vague) :
 *   A. stock restant 1, deux acheteurs
 *   B. même acheteur, double clic (même clé, séquentiel)
 *   C. même clé simultanément
 *   D. deux clés légitimes
 *   E. expiration simultanée avec tentative d'achat
 *   F. callback succès répété
 *   G. callback succès concurrent
 *   H. échec après réservation
 *   I. rollback pendant finalisation
 *   J. plusieurs instances logiques (deux contextes applicatifs distincts)
 *
 * GARDES :
 *   - `ELINTYS_ENV` doit valoir `dev`
 *   - la base connectée doit s'appeler exactement `elintys-dev`
 *   - le script ne supprime QUE les documents qu'il a lui-même créés,
 *     identifiés par leurs `_id` collectés pendant l'exécution
 *
 * Le fournisseur de paiement simulé est activé pour ce processus uniquement.
 */

process.env.TEST_PAYMENT_PROVIDER_ENABLED = 'true';
process.env.PAID_TICKET_HOLD_MINUTES = process.env.PAID_TICKET_HOLD_MINUTES ?? '15';

import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AppModule } from '../app.module';
import { TicketOrdersService } from '../modules/tickets/orders/ticket-orders.service';
import { TicketOrderStatus } from '../modules/tickets/orders/ticket-order.schema';
import { TicketHoldStatus } from '../modules/tickets/orders/ticket-hold.schema';
import { TestPaymentScenario } from '../modules/payments/providers/test-payment.provider';
import {
  assertEnvironmentGuards,
  REQUIRED_DB_NAME,
} from './migrate-sprint3-wave4-indexes';

const PREFIX = 'wave5-concurrency';

interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  details: Record<string, unknown>;
}

interface Fixture {
  eventId: Types.ObjectId;
  organizerId: Types.ObjectId;
  buyerIds: Types.ObjectId[];
  ticketTypeId: Types.ObjectId;
}

class Cleanup {
  readonly events: Types.ObjectId[] = [];
  readonly users: Types.ObjectId[] = [];
  readonly ticketTypes: Types.ObjectId[] = [];
}

async function main(): Promise<void> {
  const primary = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  // Deuxième contexte applicatif = deuxième « instance API » logique.
  const secondary = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });

  const connection = primary.get<Connection>(getConnectionToken());
  assertEnvironmentGuards(process.env.ELINTYS_ENV, connection.db?.databaseName);

  const cleanup = new Cleanup();
  const results: ScenarioResult[] = [];

  try {
    await assertIndexesPresent(connection);

    const serviceA = primary.get(TicketOrdersService);
    const serviceB = secondary.get(TicketOrdersService);

    results.push(await scenarioA(connection, cleanup, serviceA));
    results.push(await scenarioB(connection, cleanup, serviceA));
    results.push(await scenarioC(connection, cleanup, serviceA));
    results.push(await scenarioD(connection, cleanup, serviceA));
    results.push(await scenarioE(connection, cleanup, serviceA));
    results.push(await scenarioF(connection, cleanup, serviceA));
    results.push(await scenarioG(connection, cleanup, serviceA));
    results.push(await scenarioH(connection, cleanup, serviceA));
    results.push(await scenarioI(connection, cleanup, serviceA));
    results.push(await scenarioJ(connection, cleanup, serviceA, serviceB));
  } finally {
    await purge(connection, cleanup);
    await primary.close();
    await secondary.close();
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

async function assertIndexesPresent(connection: Connection): Promise<void> {
  const holds = await connection.db!.collection('ticket_holds').listIndexes().toArray();
  if (!holds.some((index) => index.name === 'ticket_holds_unique_order_line')) {
    throw new Error(
      "INDEXES_MISSING: exécuter `npm run sprint3-wave5:migrate -- --apply` avant ce script",
    );
  }
}

async function buildFixture(
  connection: Connection,
  cleanup: Cleanup,
  options: { quantity: number; buyers?: number },
): Promise<Fixture> {
  const database = connection.db!;
  const organizerId = new Types.ObjectId();
  const buyerIds = Array.from({ length: options.buyers ?? 1 }, () => new Types.ObjectId());
  const eventId = new Types.ObjectId();
  const ticketTypeId = new Types.ObjectId();
  const now = new Date();

  const users = [organizerId, ...buyerIds].map((_id, index) => ({
    _id,
    email: `${PREFIX}-${_id.toString()}@example.invalid`,
    isEmailVerified: true,
    roles: [index === 0 ? 'organisateur' : 'participant'],
    createdAt: now,
    updatedAt: now,
  }));
  await database.collection('users').insertMany(users);
  cleanup.users.push(organizerId, ...buyerIds);

  await database.collection('events').insertOne({
    _id: eventId,
    title: `${PREFIX} ${eventId.toString()}`,
    status: 'published',
    archivedAt: null,
    organizer: organizerId,
    discoverability: 'public',
    visibility: 'public',
    accessPolicy: { type: 'open' },
    admissionModes: ['paid_ticket'],
    accessModelVersion: 2,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.events.push(eventId);

  await database.collection('tickettypes').insertOne({
    _id: ticketTypeId,
    event: eventId,
    name: `${PREFIX} billet`,
    price: 2500,
    quantity: options.quantity,
    sold: 0,
    reserved: 0,
    isFree: false,
    createdAt: now,
    updatedAt: now,
  });
  cleanup.ticketTypes.push(ticketTypeId);

  return { eventId, organizerId, buyerIds, ticketTypeId };
}

/** Ne supprime QUE les documents créés par ce script, par `_id` explicite. */
async function purge(connection: Connection, cleanup: Cleanup): Promise<void> {
  const database = connection.db!;
  const orders = await database
    .collection('ticket_orders')
    .find({ event: { $in: cleanup.events } })
    .project({ _id: 1 })
    .toArray();
  const orderIds = orders.map((order) => order._id as Types.ObjectId);

  await database.collection('ticketpurchases').deleteMany({ order: { $in: orderIds } });
  await database.collection('ticket_holds').deleteMany({ orderId: { $in: orderIds } });
  await database.collection('ticket_orders').deleteMany({ _id: { $in: orderIds } });
  await database.collection('idempotent_operations').deleteMany({
    actorId: { $in: [...cleanup.users.map(String), ...orderIds.map(String)] },
  });
  await database.collection('tickettypes').deleteMany({ _id: { $in: cleanup.ticketTypes } });
  await database.collection('events').deleteMany({ _id: { $in: cleanup.events } });
  await database.collection('users').deleteMany({ _id: { $in: cleanup.users } });
}

async function inventory(
  connection: Connection,
  ticketTypeId: Types.ObjectId,
): Promise<{ quantity: number; sold: number; reserved: number }> {
  const document = await connection.db!.collection('tickettypes').findOne({ _id: ticketTypeId });
  return {
    quantity: Number(document?.quantity ?? 0),
    sold: Number(document?.sold ?? 0),
    reserved: Number(document?.reserved ?? 0),
  };
}

function invariantsHold(state: { quantity: number; sold: number; reserved: number }): boolean {
  return state.sold >= 0 && state.reserved >= 0 && state.sold + state.reserved <= state.quantity;
}

function order(ticketTypeId: Types.ObjectId, quantity: number, scenario: TestPaymentScenario) {
  return {
    lines: [{ ticketTypeId: ticketTypeId.toString(), quantity }],
    paymentScenario: scenario,
  };
}

function countFulfilled(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === 'fulfilled').length;
}

// ── Scénarios ───────────────────────────────────────────────────────────────

async function scenarioA(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 1, buyers: 2 });
  const results = await Promise.allSettled([
    service.createOrder(
      fixture.buyerIds[0].toString(),
      order(fixture.ticketTypeId, 1, TestPaymentScenario.TIMEOUT),
      `${PREFIX}-A-1`,
    ),
    service.createOrder(
      fixture.buyerIds[1].toString(),
      order(fixture.ticketTypeId, 1, TestPaymentScenario.TIMEOUT),
      `${PREFIX}-A-2`,
    ),
  ]);
  const state = await inventory(connection, fixture.ticketTypeId);
  return {
    id: 'A',
    title: 'Stock restant 1, deux acheteurs concurrents',
    passed: countFulfilled(results) === 1 && state.reserved === 1 && invariantsHold(state),
    details: { fulfilled: countFulfilled(results), ...state },
  };
}

async function scenarioB(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();
  const payload = order(fixture.ticketTypeId, 2, TestPaymentScenario.TIMEOUT);

  const first = await service.createOrder(buyer, payload, `${PREFIX}-B`);
  const second = await service.createOrder(buyer, payload, `${PREFIX}-B`);
  const state = await inventory(connection, fixture.ticketTypeId);

  return {
    id: 'B',
    title: 'Même acheteur, double clic (même clé)',
    passed: first._id === second._id && state.reserved === 2 && invariantsHold(state),
    details: { sameOrder: first._id === second._id, ...state },
  };
}

async function scenarioC(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();
  const payload = order(fixture.ticketTypeId, 2, TestPaymentScenario.TIMEOUT);

  const results = await Promise.allSettled([
    service.createOrder(buyer, payload, `${PREFIX}-C`),
    service.createOrder(buyer, payload, `${PREFIX}-C`),
    service.createOrder(buyer, payload, `${PREFIX}-C`),
  ]);
  const state = await inventory(connection, fixture.ticketTypeId);
  const orders = await connection
    .db!.collection('ticket_orders')
    .countDocuments({ event: fixture.eventId });

  return {
    id: 'C',
    title: 'Même clé, trois appels simultanés',
    passed: orders === 1 && state.reserved === 2 && invariantsHold(state),
    details: { fulfilled: countFulfilled(results), orders, ...state },
  };
}

async function scenarioD(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();

  const first = await service.createOrder(
    buyer,
    order(fixture.ticketTypeId, 1, TestPaymentScenario.TIMEOUT),
    `${PREFIX}-D-1`,
  );
  const second = await service.createOrder(
    buyer,
    order(fixture.ticketTypeId, 1, TestPaymentScenario.TIMEOUT),
    `${PREFIX}-D-2`,
  );
  const state = await inventory(connection, fixture.ticketTypeId);

  return {
    id: 'D',
    title: 'Deux clés distinctes = deux tentatives légitimes',
    passed: first._id !== second._id && state.reserved === 2 && invariantsHold(state),
    details: { distinct: first._id !== second._id, ...state },
  };
}

async function scenarioE(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 1, buyers: 2 });
  const first = await service.createOrder(
    fixture.buyerIds[0].toString(),
    order(fixture.ticketTypeId, 1, TestPaymentScenario.TIMEOUT),
    `${PREFIX}-E-1`,
  );
  await backdate(connection, first._id);

  // Expiration et nouvel achat lancés simultanément sur la dernière place.
  const [expiry, purchase] = await Promise.allSettled([
    service.expireOrder(first._id),
    service.createOrder(
      fixture.buyerIds[1].toString(),
      order(fixture.ticketTypeId, 1, TestPaymentScenario.TIMEOUT),
      `${PREFIX}-E-2`,
    ),
  ]);
  const state = await inventory(connection, fixture.ticketTypeId);
  const expiredOrder = await connection
    .db!.collection('ticket_orders')
    .findOne({ _id: new Types.ObjectId(first._id) });

  return {
    id: 'E',
    title: 'Expiration simultanée et tentative d\'achat',
    passed:
      expiredOrder?.status === TicketOrderStatus.EXPIRED &&
      state.reserved <= 1 &&
      invariantsHold(state),
    details: {
      expiry: expiry.status,
      purchase: purchase.status,
      expiredStatus: expiredOrder?.status,
      ...state,
    },
  };
}

async function scenarioF(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();
  const created = await service.createOrder(
    buyer,
    order(fixture.ticketTypeId, 2, TestPaymentScenario.DUPLICATE_CALLBACK),
    `${PREFIX}-F`,
  );

  const first = await service.syncPayment(created._id, buyer);
  const second = await service.syncPayment(created._id, buyer);
  const state = await inventory(connection, fixture.ticketTypeId);
  const admissions = await connection
    .db!.collection('ticketpurchases')
    .countDocuments({ order: new Types.ObjectId(created._id) });

  return {
    id: 'F',
    title: 'Callback succès répété',
    passed:
      first.status === TicketOrderStatus.PAID &&
      second.admissionIds.length === first.admissionIds.length &&
      admissions === 2 &&
      state.sold === 2 &&
      state.reserved === 0 &&
      invariantsHold(state),
    details: { admissions, ...state },
  };
}

async function scenarioG(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();
  const created = await service.createOrder(
    buyer,
    order(fixture.ticketTypeId, 2, TestPaymentScenario.SUCCESS),
    `${PREFIX}-G`,
  );

  await Promise.allSettled([
    service.syncPayment(created._id, buyer),
    service.syncPayment(created._id, buyer),
    service.syncPayment(created._id, buyer),
  ]);
  const state = await inventory(connection, fixture.ticketTypeId);
  const admissions = await connection
    .db!.collection('ticketpurchases')
    .countDocuments({ order: new Types.ObjectId(created._id) });

  return {
    id: 'G',
    title: 'Callbacks succès concurrents',
    passed: admissions === 2 && state.sold === 2 && state.reserved === 0 && invariantsHold(state),
    details: { admissions, ...state },
  };
}

async function scenarioH(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();
  const created = await service.createOrder(
    buyer,
    order(fixture.ticketTypeId, 3, TestPaymentScenario.DECLINED),
    `${PREFIX}-H`,
  );

  await service.syncPayment(created._id, buyer);
  await service.syncPayment(created._id, buyer);
  const state = await inventory(connection, fixture.ticketTypeId);
  const holds = await connection
    .db!.collection('ticket_holds')
    .find({ orderId: new Types.ObjectId(created._id) })
    .toArray();

  return {
    id: 'H',
    title: 'Échec de paiement après réservation',
    passed:
      state.reserved === 0 &&
      state.sold === 0 &&
      holds.every((hold) => hold.status === TicketHoldStatus.RELEASED) &&
      invariantsHold(state),
    details: { holdStatuses: holds.map((hold) => hold.status), ...state },
  };
}

async function scenarioI(
  connection: Connection,
  cleanup: Cleanup,
  service: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 10 });
  const buyer = fixture.buyerIds[0].toString();
  const created = await service.createOrder(
    buyer,
    order(fixture.ticketTypeId, 2, TestPaymentScenario.SUCCESS),
    `${PREFIX}-I`,
  );

  // Incohérence provoquée : la réservation n'est plus ACTIVE alors que la
  // commande est encore en attente. La finalisation doit alors ÉCHOUER et
  // annuler la transition PAID déjà écrite dans la transaction.
  await connection
    .db!.collection('ticket_holds')
    .updateMany(
      { orderId: new Types.ObjectId(created._id) },
      { $set: { status: TicketHoldStatus.EXPIRED } },
    );

  let rejected = false;
  try {
    await service.syncPayment(created._id, buyer);
  } catch {
    rejected = true;
  }

  const stored = await connection
    .db!.collection('ticket_orders')
    .findOne({ _id: new Types.ObjectId(created._id) });
  const admissions = await connection
    .db!.collection('ticketpurchases')
    .countDocuments({ order: new Types.ObjectId(created._id) });
  const state = await inventory(connection, fixture.ticketTypeId);

  return {
    id: 'I',
    title: 'Rollback pendant la finalisation',
    passed:
      rejected &&
      stored?.status === TicketOrderStatus.PENDING_PAYMENT &&
      admissions === 0 &&
      state.sold === 0,
    details: { rejected, storedStatus: stored?.status, admissions, ...state },
  };
}

async function scenarioJ(
  connection: Connection,
  cleanup: Cleanup,
  serviceA: TicketOrdersService,
  serviceB: TicketOrdersService,
): Promise<ScenarioResult> {
  const fixture = await buildFixture(connection, cleanup, { quantity: 1, buyers: 2 });

  // Deux contextes applicatifs distincts = deux instances API logiques.
  const results = await Promise.allSettled([
    serviceA.createOrder(
      fixture.buyerIds[0].toString(),
      order(fixture.ticketTypeId, 1, TestPaymentScenario.SUCCESS),
      `${PREFIX}-J-1`,
    ),
    serviceB.createOrder(
      fixture.buyerIds[1].toString(),
      order(fixture.ticketTypeId, 1, TestPaymentScenario.SUCCESS),
      `${PREFIX}-J-2`,
    ),
  ]);

  const winner = results.find((result) => result.status === 'fulfilled');
  let admissions = 0;
  if (winner?.status === 'fulfilled') {
    const orderId = winner.value._id;
    // La finalisation est déclenchée depuis l'AUTRE instance que celle qui a
    // créé la commande : le domaine ne doit dépendre d'aucun état de processus.
    const owner = (
      await connection.db!.collection('ticket_orders').findOne({ _id: new Types.ObjectId(orderId) })
    )?.buyerId as Types.ObjectId;
    await Promise.allSettled([
      serviceA.syncPayment(orderId, owner.toString()),
      serviceB.syncPayment(orderId, owner.toString()),
    ]);
    admissions = await connection
      .db!.collection('ticketpurchases')
      .countDocuments({ order: new Types.ObjectId(orderId) });
  }

  const state = await inventory(connection, fixture.ticketTypeId);
  return {
    id: 'J',
    title: 'Deux instances logiques : réservation puis finalisation croisée',
    passed:
      countFulfilled(results) === 1 && admissions === 1 && state.sold === 1 && invariantsHold(state),
    details: { fulfilled: countFulfilled(results), admissions, ...state },
  };
}

async function backdate(connection: Connection, orderId: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await connection
    .db!.collection('ticket_orders')
    .updateOne({ _id: new Types.ObjectId(orderId) }, { $set: { expiresAt: past } });
  await connection
    .db!.collection('ticket_holds')
    .updateMany({ orderId: new Types.ObjectId(orderId) }, { $set: { expiresAt: past } });
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
