import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TicketOrdersService } from './ticket-orders.service';
import { TicketInventoryService } from './ticket-inventory.service';
import { TicketOrderStatus } from './ticket-order.schema';
import { TicketHoldStatus } from './ticket-hold.schema';
import {
  FakeCollection,
  FakeIdempotencyService,
  FakeMongo,
  buildFakeTransactionService,
} from './ticket-orders.fake';
import { EventAccessService } from '../../events/event-access.service';
import { IdempotencyService } from '../../../shared/consistency/idempotency/idempotency.service';
import { TransactionService } from '../../../shared/consistency/transactions/transaction.service';
import { PaymentProviderRegistry } from '../../payments/providers/payment-provider.registry';
import {
  PaymentProvider,
  ProviderPaymentStatus,
} from '../../payments/providers/payment-provider.interface';
import { ErrorCodes } from '../../../shared/constants/error-codes';
import { InsufficientCapacityError } from '../../../shared/consistency/errors/consistency.errors';
import { TicketPurchaseStatus } from '../ticket.schema';

const BUYER_ID = new Types.ObjectId().toString();
const OTHER_BUYER_ID = new Types.ObjectId().toString();
const HOLD_MINUTES = 15;

interface Harness {
  service: TicketOrdersService;
  orders: FakeCollection;
  holds: FakeCollection;
  ticketTypes: FakeCollection;
  purchases: FakeCollection;
  provider: {
    name: string;
    createPayment: jest.Mock;
    getPaymentStatus: jest.Mock;
    cancelPayment: jest.Mock;
  };
  ticketTypeId: Types.ObjectId;
  secondTicketTypeId: Types.ObjectId;
  eventId: Types.ObjectId;
}

function buildHarness(
  options: {
    quantity?: number;
    sold?: number;
    reserved?: number;
    providerStatus?: ProviderPaymentStatus;
    admissionModes?: string[];
    isFree?: boolean;
  } = {},
): Harness {
  const mongo = new FakeMongo();
  const eventId = new Types.ObjectId();
  const ticketTypeId = new Types.ObjectId();
  const secondTicketTypeId = new Types.ObjectId();

  const ticketTypes = mongo.collection('tickettypes', [
    {
      _id: ticketTypeId,
      event: eventId,
      name: 'Régulier',
      price: 2500,
      quantity: options.quantity ?? 100,
      sold: options.sold ?? 0,
      reserved: options.reserved ?? 0,
      isFree: options.isFree ?? false,
    },
    {
      _id: secondTicketTypeId,
      event: eventId,
      name: 'VIP',
      price: 5000,
      quantity: 10,
      sold: 0,
      reserved: 0,
      isFree: false,
    },
  ]);
  const events = mongo.collection('events', [
    {
      _id: eventId,
      status: 'published',
      archivedAt: null,
      organizer: new Types.ObjectId(),
      discoverability: 'public',
      accessPolicy: { type: 'open' },
      admissionModes: options.admissionModes ?? ['paid_ticket'],
      accessModelVersion: 2,
    },
  ]);
  const orders = mongo.collection('ticket_orders');
  const holds = mongo.collection('ticket_holds');
  const purchases = mongo.collection('ticketpurchases');

  const provider = {
    name: 'test',
    createPayment: jest.fn().mockImplementation((input: { orderId: string }) =>
      Promise.resolve({
        provider: 'test',
        reference: `testpay:SUCCESS:${input.orderId}:1`,
        status: ProviderPaymentStatus.PENDING,
        checkoutUrl: null,
      }),
    ),
    getPaymentStatus: jest
      .fn()
      .mockResolvedValue(options.providerStatus ?? ProviderPaymentStatus.SUCCEEDED),
    cancelPayment: jest.fn().mockResolvedValue(undefined),
  };

  const registry = {
    selectForNewOrder: jest.fn(() => provider as unknown as PaymentProvider),
    resolveByName: jest.fn(() => provider as unknown as PaymentProvider),
  } as unknown as PaymentProviderRegistry;

  const eventAccessService = {
    buildActor: jest.fn().mockResolvedValue({
      userId: BUYER_ID,
      email: 'acheteur@example.ca',
      isEmailVerified: true,
      roles: ['participant'],
    }),
  } as unknown as EventAccessService;

  const configService = {
    getOrThrow: jest.fn(() => HOLD_MINUTES),
  } as unknown as ConfigService;

  const inventory = new TicketInventoryService(ticketTypes as unknown as never);

  const service = new TicketOrdersService(
    orders as unknown as never,
    holds as unknown as never,
    ticketTypes as unknown as never,
    purchases as unknown as never,
    events as unknown as never,
    inventory,
    new FakeIdempotencyService(mongo) as unknown as IdempotencyService,
    buildFakeTransactionService(mongo) as unknown as TransactionService,
    eventAccessService,
    registry,
    configService,
  );

  return {
    service,
    orders,
    holds,
    ticketTypes,
    purchases,
    provider,
    ticketTypeId,
    secondTicketTypeId,
    eventId,
  };
}

function lines(harness: Harness, quantity = 2) {
  return { lines: [{ ticketTypeId: harness.ticketTypeId.toString(), quantity }] };
}

function inventoryOf(harness: Harness, id: Types.ObjectId = harness.ticketTypeId) {
  const document = harness.ticketTypes.get(id) as {
    quantity: number;
    sold: number;
    reserved: number;
  };
  return document;
}

function assertInvariants(harness: Harness, id: Types.ObjectId = harness.ticketTypeId): void {
  const { quantity, sold, reserved } = inventoryOf(harness, id);
  expect(sold).toBeGreaterThanOrEqual(0);
  expect(reserved).toBeGreaterThanOrEqual(0);
  expect(sold + reserved).toBeLessThanOrEqual(quantity);
}

afterEach(() => jest.clearAllMocks());

// ── Création ────────────────────────────────────────────────────────────────

describe('TicketOrdersService — création de commande', () => {
  it('devrait créer la commande, la réservation et incrémenter reserved', async () => {
    const harness = buildHarness();

    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-1');

    expect(order.status).toBe(TicketOrderStatus.PENDING_PAYMENT);
    expect(order.totalAmount).toBe(5000);
    expect(order.payment.provider).toBe('test');
    expect(order.payment.checkoutUrl).toBeNull();
    expect(inventoryOf(harness)).toMatchObject({ sold: 0, reserved: 2 });

    const hold = harness.holds.all()[0];
    expect(hold).toMatchObject({ status: TicketHoldStatus.ACTIVE, quantity: 2 });
    assertInvariants(harness);
  });

  it('ne devrait jamais exposer la référence du fournisseur au client', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-ref');
    expect(JSON.stringify(order)).not.toContain('testpay');
  });

  it('devrait poser une expiration alignée sur PAID_TICKET_HOLD_MINUTES', async () => {
    const harness = buildHarness();
    const before = Date.now();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-exp');
    const delta = Date.parse(order.expiresAt) - before;

    expect(delta).toBeGreaterThan((HOLD_MINUTES - 1) * 60_000);
    expect(delta).toBeLessThanOrEqual(HOLD_MINUTES * 60_000 + 1_000);
  });

  it('devrait refuser une commande dépassant la capacité restante', async () => {
    const harness = buildHarness({ quantity: 100, sold: 90, reserved: 8 });

    await expect(
      harness.service.createOrder(BUYER_ID, lines(harness, 3), 'key-2'),
    ).rejects.toBeInstanceOf(InsufficientCapacityError);

    expect(inventoryOf(harness)).toMatchObject({ sold: 90, reserved: 8 });
    expect(harness.orders.all()).toHaveLength(0);
    assertInvariants(harness);
  });

  it('devrait refuser un billet gratuit dans une commande payante', async () => {
    const harness = buildHarness({ isFree: true });
    await expect(
      harness.service.createOrder(BUYER_ID, lines(harness), 'key-3'),
    ).rejects.toThrow(ErrorCodes.TICKET_ORDER_PAID_TICKET_REQUIRED);
  });

  it("devrait refuser un événement sans admission paid_ticket", async () => {
    const harness = buildHarness({ admissionModes: ['registration_only'] });
    await expect(
      harness.service.createOrder(BUYER_ID, lines(harness), 'key-4'),
    ).rejects.toThrow(ErrorCodes.TICKET_ORDER_ADMISSION_NOT_AVAILABLE);
  });

  it('devrait refuser deux lignes sur le même type de billet', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.createOrder(
        BUYER_ID,
        {
          lines: [
            { ticketTypeId: harness.ticketTypeId.toString(), quantity: 1 },
            { ticketTypeId: harness.ticketTypeId.toString(), quantity: 1 },
          ],
        },
        'key-5',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('devrait refuser un scénario de simulation avec un fournisseur non simulé', async () => {
    const harness = buildHarness();
    harness.provider.name = 'stripe';
    await expect(
      harness.service.createOrder(
        BUYER_ID,
        { ...lines(harness), paymentScenario: 'SUCCESS' as never },
        'key-6',
      ),
    ).rejects.toThrow(ErrorCodes.TICKET_ORDER_SCENARIO_NOT_ALLOWED);
  });

  it('devrait réserver chaque ligne d\'une commande multi-lignes', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(
      BUYER_ID,
      {
        lines: [
          { ticketTypeId: harness.ticketTypeId.toString(), quantity: 2 },
          { ticketTypeId: harness.secondTicketTypeId.toString(), quantity: 1 },
        ],
      },
      'key-multi',
    );

    expect(order.totalAmount).toBe(2 * 2500 + 5000);
    expect(inventoryOf(harness).reserved).toBe(2);
    expect(inventoryOf(harness, harness.secondTicketTypeId).reserved).toBe(1);
    expect(harness.holds.all()).toHaveLength(2);
  });

  it('devrait tout annuler si une ligne de la commande ne peut pas être réservée', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.createOrder(
        BUYER_ID,
        {
          lines: [
            { ticketTypeId: harness.ticketTypeId.toString(), quantity: 2 },
            { ticketTypeId: harness.secondTicketTypeId.toString(), quantity: 99 },
          ],
        },
        'key-partial',
      ),
    ).rejects.toBeInstanceOf(InsufficientCapacityError);

    expect(inventoryOf(harness).reserved).toBe(0);
    expect(harness.orders.all()).toHaveLength(0);
    expect(harness.holds.all()).toHaveLength(0);
  });

  it('devrait libérer la commande si le fournisseur de paiement est indisponible', async () => {
    const harness = buildHarness();
    harness.provider.createPayment.mockRejectedValue(new Error('provider down'));

    await expect(
      harness.service.createOrder(BUYER_ID, lines(harness), 'key-7'),
    ).rejects.toThrow(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE);

    expect(inventoryOf(harness).reserved).toBe(0);
    expect(harness.orders.all()[0]).toMatchObject({ status: TicketOrderStatus.FAILED });
    assertInvariants(harness);
  });
});

// ── Idempotence et concurrence de création ──────────────────────────────────

describe('TicketOrdersService — idempotence de création', () => {
  it('B/C. devrait rejouer la même commande pour la même clé et le même payload', async () => {
    const harness = buildHarness();

    const first = await harness.service.createOrder(BUYER_ID, lines(harness), 'same-key');
    const second = await harness.service.createOrder(BUYER_ID, lines(harness), 'same-key');

    expect(second._id).toBe(first._id);
    expect(harness.orders.all()).toHaveLength(1);
    expect(inventoryOf(harness).reserved).toBe(2);
    expect(harness.provider.createPayment).toHaveBeenCalledTimes(1);
  });

  it('devrait refuser la même clé avec un payload différent', async () => {
    const harness = buildHarness();
    await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'same-key');

    await expect(
      harness.service.createOrder(BUYER_ID, lines(harness, 3), 'same-key'),
    ).rejects.toThrow(ErrorCodes.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD);

    expect(harness.orders.all()).toHaveLength(1);
  });

  it('D. devrait accepter deux clés distinctes comme deux tentatives légitimes', async () => {
    const harness = buildHarness();

    const first = await harness.service.createOrder(BUYER_ID, lines(harness, 1), 'key-a');
    const second = await harness.service.createOrder(BUYER_ID, lines(harness, 1), 'key-b');

    expect(second._id).not.toBe(first._id);
    expect(inventoryOf(harness).reserved).toBe(2);
  });

  it('devrait exiger une clé d\'idempotence', async () => {
    const harness = buildHarness();
    await expect(harness.service.createOrder(BUYER_ID, lines(harness), '')).rejects.toThrow(
      ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
    );
  });

  it('A. ne devrait accorder les 2 derniers billets qu\'à un seul de deux acheteurs concurrents', async () => {
    const harness = buildHarness({ quantity: 100, sold: 90, reserved: 8 });

    const results = await Promise.allSettled([
      harness.service.createOrder(BUYER_ID, lines(harness, 2), 'buyer-1'),
      harness.service.createOrder(OTHER_BUYER_ID, lines(harness, 2), 'buyer-2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(inventoryOf(harness).reserved).toBe(10);
    assertInvariants(harness);
  });
});

// ── Finalisation ────────────────────────────────────────────────────────────

describe('TicketOrdersService — finalisation du paiement', () => {
  it('devrait passer PAID, consommer la réservation et émettre les admissions', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-paid');

    const settled = await harness.service.syncPayment(order._id, BUYER_ID);

    expect(settled.status).toBe(TicketOrderStatus.PAID);
    expect(settled.admissionIds).toHaveLength(2);
    expect(inventoryOf(harness)).toMatchObject({ sold: 2, reserved: 0 });
    expect(harness.holds.all()[0]).toMatchObject({ status: TicketHoldStatus.CONSUMED });
    expect(harness.purchases.all()).toHaveLength(2);
    expect(harness.purchases.all()[0]).toMatchObject({
      status: TicketPurchaseStatus.VALID,
      price: 2500,
    });
    assertInvariants(harness);
  });

  it('F. ne devrait produire aucun effet supplémentaire sur un second succès', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-dup');

    const first = await harness.service.syncPayment(order._id, BUYER_ID);
    const second = await harness.service.syncPayment(order._id, BUYER_ID);

    expect(second.admissionIds).toEqual(first.admissionIds);
    expect(harness.purchases.all()).toHaveLength(2);
    expect(inventoryOf(harness)).toMatchObject({ sold: 2, reserved: 0 });
    assertInvariants(harness);
  });

  it('G. ne devrait produire qu\'un seul effet sur deux succès concurrents', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-conc');

    await Promise.allSettled([
      harness.service.syncPayment(order._id, BUYER_ID),
      harness.service.syncPayment(order._id, BUYER_ID),
      harness.service.syncPayment(order._id, BUYER_ID),
    ]);

    expect(harness.purchases.all()).toHaveLength(2);
    expect(inventoryOf(harness)).toMatchObject({ sold: 2, reserved: 0 });
    expect(harness.orders.all()[0]).toMatchObject({ status: TicketOrderStatus.PAID });
    assertInvariants(harness);
  });

  it('devrait laisser la commande en attente tant que le paiement est PENDING', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.PENDING });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-pending');

    const synced = await harness.service.syncPayment(order._id, BUYER_ID);

    expect(synced.status).toBe(TicketOrderStatus.PENDING_PAYMENT);
    expect(inventoryOf(harness).reserved).toBe(2);
    expect(harness.purchases.all()).toHaveLength(0);
  });
});

// ── Échec, annulation, expiration ───────────────────────────────────────────

describe('TicketOrdersService — échec et annulation', () => {
  it('H. devrait libérer la réservation exactement une fois sur refus du paiement', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.FAILED });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-fail');

    const failed = await harness.service.syncPayment(order._id, BUYER_ID);
    await harness.service.syncPayment(order._id, BUYER_ID);

    expect(failed.status).toBe(TicketOrderStatus.FAILED);
    expect(inventoryOf(harness)).toMatchObject({ sold: 0, reserved: 0 });
    expect(harness.holds.all()[0]).toMatchObject({ status: TicketHoldStatus.RELEASED });
    assertInvariants(harness);
  });

  it('devrait annuler la commande sur annulation du fournisseur', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.CANCELLED });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-provider-cancel');

    const cancelled = await harness.service.syncPayment(order._id, BUYER_ID);

    expect(cancelled.status).toBe(TicketOrderStatus.CANCELLED);
    expect(inventoryOf(harness).reserved).toBe(0);
  });

  it('devrait permettre à l\'acheteur d\'annuler et libérer la capacité', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-cancel');

    const cancelled = await harness.service.cancelOrder(order._id, BUYER_ID);

    expect(cancelled.status).toBe(TicketOrderStatus.CANCELLED);
    expect(inventoryOf(harness).reserved).toBe(0);
    expect(harness.provider.cancelPayment).toHaveBeenCalledTimes(1);
    assertInvariants(harness);
  });

  it('devrait conserver le succès local si l\'annulation fournisseur échoue après commit', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-cancel-down');
    harness.provider.cancelPayment.mockRejectedValueOnce(new Error('provider unavailable'));

    const cancelled = await harness.service.cancelOrder(order._id, BUYER_ID);

    expect(cancelled.status).toBe(TicketOrderStatus.CANCELLED);
    expect(inventoryOf(harness).reserved).toBe(0);
    expect(harness.provider.cancelPayment).toHaveBeenCalledTimes(1);
    assertInvariants(harness);
  });

  it('devrait refuser une seconde annulation', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-cancel-2');
    await harness.service.cancelOrder(order._id, BUYER_ID);

    await expect(harness.service.cancelOrder(order._id, BUYER_ID)).rejects.toThrow(
      ErrorCodes.TICKET_ORDER_NOT_PENDING,
    );
    expect(inventoryOf(harness).reserved).toBe(0);
  });

  it('devrait refuser l\'annulation d\'une commande déjà payée', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-cancel-paid');
    await harness.service.syncPayment(order._id, BUYER_ID);

    await expect(harness.service.cancelOrder(order._id, BUYER_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(inventoryOf(harness)).toMatchObject({ sold: 2, reserved: 0 });
  });
});

describe('TicketOrdersService — expiration', () => {
  async function buildExpiredOrder(quantity = 2): Promise<{ harness: Harness; orderId: string }> {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.PENDING });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, quantity), 'key-exp');
    const past = new Date(Date.now() - 60_000);
    await harness.orders.updateOne({ _id: new Types.ObjectId(order._id) }, { $set: { expiresAt: past } });
    await harness.holds.updateOne(
      { orderId: new Types.ObjectId(order._id) },
      { $set: { expiresAt: past } },
    );
    return { harness, orderId: order._id };
  }

  it('devrait expirer la commande et restituer la capacité exactement une fois', async () => {
    const { harness, orderId } = await buildExpiredOrder();

    expect(await harness.service.expireOrder(orderId)).toBe(true);
    expect(await harness.service.expireOrder(orderId)).toBe(false);

    expect(harness.orders.get(orderId)).toMatchObject({ status: TicketOrderStatus.EXPIRED });
    expect(harness.holds.all()[0]).toMatchObject({ status: TicketHoldStatus.EXPIRED });
    expect(inventoryOf(harness)).toMatchObject({ sold: 0, reserved: 0 });
    assertInvariants(harness);
  });

  it('ne devrait jamais expirer une commande encore valide', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.PENDING });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-valid');

    expect(await harness.service.expireOrder(order._id)).toBe(false);
    expect(inventoryOf(harness).reserved).toBe(2);
  });

  it('devrait expirer les commandes périmées lors du balayage', async () => {
    const { harness } = await buildExpiredOrder();

    await expect(harness.service.sweepExpiredOrders()).resolves.toEqual({
      scanned: 1,
      expired: 1,
    });
    await expect(harness.service.sweepExpiredOrders()).resolves.toEqual({
      scanned: 0,
      expired: 0,
    });
    expect(inventoryOf(harness).reserved).toBe(0);
  });

  it('E. devrait rendre la capacité expirée réutilisable par un nouvel acheteur', async () => {
    const harness = buildHarness({ quantity: 2, providerStatus: ProviderPaymentStatus.PENDING });
    const first = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-first');

    await expect(
      harness.service.createOrder(OTHER_BUYER_ID, lines(harness, 2), 'key-second'),
    ).rejects.toBeInstanceOf(InsufficientCapacityError);

    const past = new Date(Date.now() - 60_000);
    await harness.orders.updateOne({ _id: new Types.ObjectId(first._id) }, { $set: { expiresAt: past } });
    await harness.holds.updateOne(
      { orderId: new Types.ObjectId(first._id) },
      { $set: { expiresAt: past } },
    );

    // L'expiration paresseuse restitue la capacité avant d'évaluer la disponibilité.
    const second = await harness.service.createOrder(OTHER_BUYER_ID, lines(harness, 2), 'key-third');

    expect(second.status).toBe(TicketOrderStatus.PENDING_PAYMENT);
    expect(harness.orders.get(first._id)).toMatchObject({ status: TicketOrderStatus.EXPIRED });
    expect(inventoryOf(harness)).toMatchObject({ sold: 0, reserved: 2 });
    assertInvariants(harness);
  });

  it('devrait refuser de finaliser une commande dont la réservation vient d\'expirer', async () => {
    const { harness, orderId } = await buildExpiredOrder();
    harness.provider.getPaymentStatus.mockResolvedValue(ProviderPaymentStatus.SUCCEEDED);

    await expect(harness.service.syncPayment(orderId, BUYER_ID)).rejects.toThrow(
      ErrorCodes.TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW,
    );

    expect(harness.purchases.all()).toHaveLength(0);
    expect(inventoryOf(harness)).toMatchObject({ sold: 0, reserved: 0 });
    assertInvariants(harness);
  });
});

// ── Paiement tardif ─────────────────────────────────────────────────────────

describe('TicketOrdersService — paiement confirmé après clôture', () => {
  it('devrait escalader sans créer d\'admission ni consommer de stock', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.PENDING });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness, 2), 'key-late');
    await harness.service.cancelOrder(order._id, BUYER_ID);

    harness.provider.getPaymentStatus.mockResolvedValue(ProviderPaymentStatus.SUCCEEDED);
    await expect(harness.service.syncPayment(order._id, BUYER_ID)).rejects.toThrow(
      ErrorCodes.TICKET_ORDER_LATE_PAYMENT_REQUIRES_REVIEW,
    );

    const stored = harness.orders.get(order._id) as {
      status: string;
      requiresManualReview: boolean;
      lateSettlement: { providerStatus: string } | null;
    };
    expect(stored.status).toBe(TicketOrderStatus.CANCELLED);
    expect(stored.requiresManualReview).toBe(true);
    expect(stored.lateSettlement?.providerStatus).toBe(ProviderPaymentStatus.SUCCEEDED);
    expect(harness.purchases.all()).toHaveLength(0);
    expect(inventoryOf(harness)).toMatchObject({ sold: 0, reserved: 0 });
  });

  it('devrait rester idempotent : la revue manuelle n\'est signalée qu\'une fois', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.PENDING });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-late-2');
    await harness.service.cancelOrder(order._id, BUYER_ID);
    harness.provider.getPaymentStatus.mockResolvedValue(ProviderPaymentStatus.SUCCEEDED);

    await expect(harness.service.syncPayment(order._id, BUYER_ID)).rejects.toThrow();
    const firstDetection = (
      harness.orders.get(order._id) as { lateSettlement: { detectedAt: Date } }
    ).lateSettlement.detectedAt;

    await expect(harness.service.syncPayment(order._id, BUYER_ID)).rejects.toThrow();
    const secondDetection = (
      harness.orders.get(order._id) as { lateSettlement: { detectedAt: Date } }
    ).lateSettlement.detectedAt;

    expect(secondDetection).toEqual(firstDetection);
  });

  it('ne devrait pas escalader lorsque le fournisseur confirme aussi un échec', async () => {
    const harness = buildHarness({ providerStatus: ProviderPaymentStatus.PENDING });
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-late-3');
    await harness.service.cancelOrder(order._id, BUYER_ID);
    harness.provider.getPaymentStatus.mockResolvedValue(ProviderPaymentStatus.FAILED);

    const view = await harness.service.syncPayment(order._id, BUYER_ID);
    expect(view.status).toBe(TicketOrderStatus.CANCELLED);
    expect(view.requiresManualReview).toBe(false);
  });
});

// ── Lecture et propriété ────────────────────────────────────────────────────

describe('TicketOrdersService — lecture et contrôle de propriété', () => {
  it('devrait interdire l\'accès à la commande d\'un autre acheteur', async () => {
    const harness = buildHarness();
    const order = await harness.service.createOrder(BUYER_ID, lines(harness), 'key-own');

    await expect(harness.service.findOne(order._id, OTHER_BUYER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(harness.service.cancelOrder(order._id, OTHER_BUYER_ID)).rejects.toThrow(
      ErrorCodes.TICKET_ORDER_NOT_FOUND,
    );
    await expect(harness.service.syncPayment(order._id, OTHER_BUYER_ID)).rejects.toThrow(
      ErrorCodes.TICKET_ORDER_NOT_FOUND,
    );
  });

  it('devrait paginer mes commandes', async () => {
    const harness = buildHarness();
    await harness.service.createOrder(BUYER_ID, lines(harness, 1), 'key-p1');
    await harness.service.createOrder(BUYER_ID, lines(harness, 1), 'key-p2');
    await harness.service.createOrder(OTHER_BUYER_ID, lines(harness, 1), 'key-p3');

    const page = await harness.service.findMine(BUYER_ID, { page: 1, limit: 1 });

    expect(page.total).toBe(2);
    expect(page.data).toHaveLength(1);
    expect(page.limit).toBe(1);
  });

  it('devrait signaler une commande inexistante', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.findOne(new Types.ObjectId().toString(), BUYER_ID),
    ).rejects.toThrow(ErrorCodes.TICKET_ORDER_NOT_FOUND);
  });
});
