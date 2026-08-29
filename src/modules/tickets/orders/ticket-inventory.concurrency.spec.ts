import { ClientSession, Model, Types } from 'mongoose';
import { TicketInventoryService } from './ticket-inventory.service';
import { TicketTypeDocument } from '../ticket.schema';
import { AtomicTicketTypeFakeModel, FakeTicketTypeState } from './atomic-ticket-type.fake';

/**
 * Concurrence au niveau de l'INVENTAIRE, exécutable en CI sans MongoDB.
 *
 * Le modèle en mémoire ne reproduit qu'une seule chose : l'atomicité MongoDB
 * au niveau d'un document. C'est exactement la propriété sur laquelle repose
 * l'invariant `sold + reserved <= quantity`.
 *
 * La preuve sur MongoDB réel (replica set, transactions, plusieurs instances
 * logiques) est produite séparément par `src/scripts/verify-wave5-concurrency.ts`.
 */

const SESSION = {} as ClientSession;

function build(state: Partial<FakeTicketTypeState>): {
  service: TicketInventoryService;
  fake: AtomicTicketTypeFakeModel;
  id: Types.ObjectId;
} {
  const id = new Types.ObjectId();
  const document: FakeTicketTypeState = {
    _id: id,
    quantity: 100,
    sold: 0,
    reserved: 0,
    isFree: false,
    ...state,
  };
  const fake = new AtomicTicketTypeFakeModel([document]);
  return {
    service: new TicketInventoryService(fake as unknown as Model<TicketTypeDocument>),
    fake,
    id,
  };
}

function assertInvariants(state: FakeTicketTypeState): void {
  expect(state.sold).toBeGreaterThanOrEqual(0);
  expect(state.reserved ?? 0).toBeGreaterThanOrEqual(0);
  expect(state.sold + (state.reserved ?? 0)).toBeLessThanOrEqual(state.quantity);
}

async function settle<T>(promises: Promise<T>[]): Promise<{ fulfilled: number; rejected: number }> {
  const results = await Promise.allSettled(promises);
  return {
    fulfilled: results.filter((result) => result.status === 'fulfilled').length,
    rejected: results.filter((result) => result.status === 'rejected').length,
  };
}

afterEach(() => jest.clearAllMocks());

describe('Concurrence inventaire — invariant sold + reserved <= quantity', () => {
  it('A. devrait n\'accorder les 2 derniers billets qu\'à un seul des deux acheteurs', async () => {
    const { service, fake, id } = build({ quantity: 100, sold: 90, reserved: 8 });

    const outcome = await settle([
      service.reserve(id, 2, SESSION),
      service.reserve(id, 2, SESSION),
    ]);

    expect(outcome).toEqual({ fulfilled: 1, rejected: 1 });
    expect(fake.snapshot(id).reserved).toBe(10);
    assertInvariants(fake.snapshot(id));
  });

  it('devrait n\'accorder le dernier billet qu\'à un seul acheteur parmi vingt', async () => {
    const { service, fake, id } = build({ quantity: 10, sold: 9, reserved: 0 });

    const outcome = await settle(
      Array.from({ length: 20 }, () => service.reserve(id, 1, SESSION)),
    );

    expect(outcome).toEqual({ fulfilled: 1, rejected: 19 });
    assertInvariants(fake.snapshot(id));
  });

  it('devrait rester correct sous rafale mixte réservation / libération / consommation', async () => {
    const { service, fake, id } = build({ quantity: 30, sold: 0, reserved: 0 });

    // Phase 1 : 40 tentatives de réservation de 1 sur 30 places.
    const reservations = await settle(
      Array.from({ length: 40 }, () => service.reserve(id, 1, SESSION)),
    );
    expect(reservations.fulfilled).toBe(30);
    expect(fake.snapshot(id).reserved).toBe(30);

    // Phase 2 : 10 consommations et 10 libérations entrelacées.
    await settle([
      ...Array.from({ length: 10 }, () => service.consumeReservation(id, 1, SESSION)),
      ...Array.from({ length: 10 }, () => service.releaseReservation(id, 1, SESSION)),
    ]);

    const state = fake.snapshot(id);
    expect(state.sold).toBe(10);
    expect(state.reserved).toBe(10);
    assertInvariants(state);
  });

  it('I. devrait empêcher deux consommations concurrentes de la même réservation', async () => {
    const { service, fake, id } = build({ quantity: 10, sold: 0, reserved: 1 });

    const outcome = await settle([
      service.consumeReservation(id, 1, SESSION),
      service.consumeReservation(id, 1, SESSION),
    ]);

    expect(outcome).toEqual({ fulfilled: 1, rejected: 1 });
    expect(fake.snapshot(id)).toMatchObject({ sold: 1, reserved: 0 });
    assertInvariants(fake.snapshot(id));
  });

  it('H. devrait empêcher deux libérations concurrentes de la même réservation', async () => {
    const { service, fake, id } = build({ quantity: 10, sold: 0, reserved: 1 });

    const outcome = await settle([
      service.releaseReservation(id, 1, SESSION),
      service.releaseReservation(id, 1, SESSION),
    ]);

    expect(outcome).toEqual({ fulfilled: 1, rejected: 1 });
    expect(fake.snapshot(id).reserved).toBe(0);
    assertInvariants(fake.snapshot(id));
  });

  it('E. devrait rendre exclusives une expiration et une consommation concurrentes', async () => {
    const { service, fake, id } = build({ quantity: 10, sold: 0, reserved: 1 });

    const outcome = await settle([
      service.consumeReservation(id, 1, SESSION),
      service.releaseReservation(id, 1, SESSION),
    ]);

    expect(outcome).toEqual({ fulfilled: 1, rejected: 1 });
    const state = fake.snapshot(id);
    expect(state.reserved).toBe(0);
    expect([0, 1]).toContain(state.sold);
    assertInvariants(state);
  });

  it('devrait libérer la capacité expirée et la rendre réutilisable', async () => {
    const { service, fake, id } = build({ quantity: 2, sold: 0, reserved: 2 });

    await expect(service.reserve(id, 1, SESSION)).rejects.toThrow();
    await service.releaseReservation(id, 2, SESSION);
    await service.reserve(id, 2, SESSION);

    expect(fake.snapshot(id).reserved).toBe(2);
    assertInvariants(fake.snapshot(id));
  });
});
