import { Types } from 'mongoose';
import { ClientSession, Model } from 'mongoose';
import {
  INVENTORY_CONSUME_FAILED,
  INVENTORY_RELEASE_FAILED,
  TicketInventoryConsistencyError,
  TicketInventoryService,
} from './ticket-inventory.service';
import { TicketTypeDocument } from '../ticket.schema';
import { InsufficientCapacityError } from '../../../shared/consistency/errors/consistency.errors';
import { AtomicTicketTypeFakeModel, FakeTicketTypeState } from './atomic-ticket-type.fake';

const SESSION = {} as ClientSession;

function buildService(documents: FakeTicketTypeState[]): {
  service: TicketInventoryService;
  fake: AtomicTicketTypeFakeModel;
} {
  const fake = new AtomicTicketTypeFakeModel(documents);
  const service = new TicketInventoryService(
    fake as unknown as Model<TicketTypeDocument>,
  );
  return { service, fake };
}

function ticketType(overrides: Partial<FakeTicketTypeState> = {}): FakeTicketTypeState {
  return {
    _id: new Types.ObjectId(),
    quantity: 100,
    sold: 0,
    reserved: 0,
    isFree: false,
    ...overrides,
  };
}

afterEach(() => jest.clearAllMocks());

describe('TicketInventoryService — réservation', () => {
  it('devrait réserver lorsque la capacité disponible suffit', async () => {
    const document = ticketType({ quantity: 100, sold: 90, reserved: 8 });
    const { service, fake } = buildService([document]);

    await service.reserve(document._id, 2, SESSION);

    expect(fake.snapshot(document._id).reserved).toBe(10);
  });

  it('devrait refuser une réservation qui dépasserait la quantité totale', async () => {
    const document = ticketType({ quantity: 100, sold: 90, reserved: 8 });
    const { service, fake } = buildService([document]);

    await expect(service.reserve(document._id, 3, SESSION)).rejects.toBeInstanceOf(
      InsufficientCapacityError,
    );
    expect(fake.snapshot(document._id).reserved).toBe(8);
  });

  it('devrait refuser de réserver sur un billet gratuit', async () => {
    const document = ticketType({ isFree: true });
    const { service } = buildService([document]);

    await expect(service.reserve(document._id, 1, SESSION)).rejects.toBeInstanceOf(
      InsufficientCapacityError,
    );
  });

  it('devrait rester correct sur un document antérieur à la Vague 5 sans champ reserved', async () => {
    const document = ticketType({ quantity: 10, sold: 9, reserved: undefined });
    const { service, fake } = buildService([document]);

    await service.reserve(document._id, 1, SESSION);
    expect(fake.snapshot(document._id).reserved).toBe(1);

    await expect(service.reserve(document._id, 1, SESSION)).rejects.toBeInstanceOf(
      InsufficientCapacityError,
    );
  });
});

describe('TicketInventoryService — consommation', () => {
  it('devrait transférer la réservation vers les ventes', async () => {
    const document = ticketType({ quantity: 10, sold: 2, reserved: 3 });
    const { service, fake } = buildService([document]);

    await service.consumeReservation(document._id, 3, SESSION);

    const after = fake.snapshot(document._id);
    expect(after).toMatchObject({ sold: 5, reserved: 0 });
    expect(after.sold + (after.reserved ?? 0)).toBeLessThanOrEqual(after.quantity);
  });

  it('devrait refuser une seconde consommation de la même réservation', async () => {
    const document = ticketType({ quantity: 10, sold: 0, reserved: 2 });
    const { service, fake } = buildService([document]);

    await service.consumeReservation(document._id, 2, SESSION);
    await expect(service.consumeReservation(document._id, 2, SESSION)).rejects.toThrow(
      INVENTORY_CONSUME_FAILED,
    );
    expect(fake.snapshot(document._id).reserved).toBe(0);
  });
});

describe('TicketInventoryService — libération', () => {
  it('devrait libérer la capacité réservée', async () => {
    const document = ticketType({ quantity: 10, sold: 1, reserved: 4 });
    const { service, fake } = buildService([document]);

    await service.releaseReservation(document._id, 4, SESSION);

    expect(fake.snapshot(document._id).reserved).toBe(0);
  });

  it('devrait empêcher reserved de devenir négatif lors d\'une double libération', async () => {
    const document = ticketType({ quantity: 10, sold: 0, reserved: 1 });
    const { service, fake } = buildService([document]);

    await service.releaseReservation(document._id, 1, SESSION);
    await expect(service.releaseReservation(document._id, 1, SESSION)).rejects.toBeInstanceOf(
      TicketInventoryConsistencyError,
    );
    await expect(service.releaseReservation(document._id, 1, SESSION)).rejects.toThrow(
      INVENTORY_RELEASE_FAILED,
    );
    expect(fake.snapshot(document._id).reserved).toBe(0);
  });
});

describe('TicketInventoryService.availableFrom', () => {
  it.each([
    [{ quantity: 100, sold: 90, reserved: 8 }, 2],
    [{ quantity: 100, sold: 100, reserved: 0 }, 0],
    [{ quantity: 10, sold: 0 }, 10],
    [{ quantity: 5, sold: 5, reserved: 5 }, 0],
  ])('devrait calculer la disponibilité de %j', (input, expected) => {
    expect(TicketInventoryService.availableFrom(input)).toBe(expected);
  });
});
