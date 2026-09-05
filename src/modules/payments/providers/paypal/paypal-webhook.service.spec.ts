import { Model } from 'mongoose';
import {
  extractIdentifiers,
  HANDLED_EVENT_TYPES,
  isHandledEventType,
  PayPalWebhookService,
} from './paypal-webhook.service';
import {
  PayPalWebhookEventDocument,
  PayPalWebhookEventStatus,
} from './paypal-webhook-event.schema';
import { VerifiedWebhookEvent } from './paypal-webhook.verifier';
import { TicketOrdersService } from '../../../tickets/orders/ticket-orders.service';

/** Journal en mémoire reproduisant l'index unique sur `eventId`. */
class FakeEventModel {
  readonly rows = new Map<string, Record<string, unknown>>();

  create(doc: Record<string, unknown>): Promise<unknown> {
    const eventId = String(doc.eventId);
    if (this.rows.has(eventId)) {
      return Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
    }
    this.rows.set(eventId, { ...doc });
    return Promise.resolve(doc);
  }

  findOneAndUpdate(
    filter: {
      eventId: string;
      $or?: { status?: string; leaseExpiresAt?: { $lte: Date } }[];
    },
    update: { $set: Record<string, unknown> },
  ): Promise<unknown> {
    const row = this.rows.get(filter.eventId);
    if (!row) return Promise.resolve(null);

    const matches = (filter.$or ?? [{}]).some((clause) => {
      if (clause.status !== undefined && clause.status !== row.status) return false;
      if (clause.leaseExpiresAt) {
        const lease = row.leaseExpiresAt as Date | null | undefined;
        if (!lease || lease.getTime() > clause.leaseExpiresAt.$lte.getTime()) return false;
      }
      return true;
    });
    if (!matches) return Promise.resolve(null);

    Object.assign(row, update.$set);
    return Promise.resolve(row);
  }

  updateOne(
    filter: { eventId: string; processingToken?: string; status?: string },
    update: { $set: Record<string, unknown> },
  ): Promise<{ modifiedCount: number }> {
    const row = this.rows.get(filter.eventId);
    if (!row) return Promise.resolve({ modifiedCount: 0 });
    if (filter.processingToken !== undefined && row.processingToken !== filter.processingToken) {
      return Promise.resolve({ modifiedCount: 0 });
    }
    if (filter.status !== undefined && row.status !== filter.status) {
      return Promise.resolve({ modifiedCount: 0 });
    }
    Object.assign(row, update.$set);
    return Promise.resolve({ modifiedCount: 1 });
  }
}

function build(options: { resolvedOrderId?: string | null; syncFails?: boolean } = {}) {
  const model = new FakeEventModel();
  const syncPaymentAsServer = jest.fn().mockImplementation(() =>
    options.syncFails ? Promise.reject(new Error('boom')) : Promise.resolve({}),
  );
  const ticketOrders = {
    findIdByProviderReference: jest
      .fn()
      .mockResolvedValue(
        options.resolvedOrderId === undefined ? 'ticket-order-1' : options.resolvedOrderId,
      ),
    syncPaymentAsServer,
  } as unknown as TicketOrdersService;

  return {
    service: new PayPalWebhookService(
      model as unknown as Model<PayPalWebhookEventDocument>,
      ticketOrders,
    ),
    model,
    ticketOrders: ticketOrders as unknown as {
      findIdByProviderReference: jest.Mock;
      syncPaymentAsServer: jest.Mock;
    },
  };
}

function captureEvent(overrides: Partial<VerifiedWebhookEvent> = {}): VerifiedWebhookEvent {
  return {
    eventId: 'WH-1',
    eventType: 'PAYMENT.CAPTURE.COMPLETED',
    createTime: '2026-08-29T12:00:00Z',
    resource: {
      id: 'CAPTURE-1',
      custom_id: 'ticket-order-1',
      supplementary_data: { related_ids: { order_id: 'PP-ORDER-1' } },
    },
    ...overrides,
  };
}

afterEach(() => jest.clearAllMocks());

describe('PayPalWebhookService — traitement', () => {
  it('devrait traiter un événement de capture et synchroniser la commande', async () => {
    const { service, model, ticketOrders } = build();

    await expect(service.handle(captureEvent())).resolves.toBe('processed');

    expect(ticketOrders.findIdByProviderReference).toHaveBeenCalledWith('PP-ORDER-1');
    expect(ticketOrders.syncPaymentAsServer).toHaveBeenCalledWith('ticket-order-1');
    expect(model.rows.get('WH-1')).toMatchObject({
      status: PayPalWebhookEventStatus.PROCESSED,
      providerOrderId: 'PP-ORDER-1',
      providerCaptureId: 'CAPTURE-1',
      ticketOrderId: 'ticket-order-1',
    });
  });

  it('ne devrait produire aucun effet supplémentaire sur un doublon', async () => {
    const { service, ticketOrders } = build();

    await service.handle(captureEvent());
    await expect(service.handle(captureEvent())).resolves.toBe('duplicate');

    expect(ticketOrders.syncPaymentAsServer).toHaveBeenCalledTimes(1);
  });

  it('ne devrait produire qu\'un seul effet sur des livraisons concurrentes', async () => {
    const { service, ticketOrders } = build();

    const outcomes = await Promise.all([
      service.handle(captureEvent()),
      service.handle(captureEvent()),
      service.handle(captureEvent()),
    ]);

    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(ticketOrders.syncPaymentAsServer).toHaveBeenCalledTimes(1);
  });

  it('devrait ignorer explicitement un type hors périmètre', async () => {
    const { service, model, ticketOrders } = build();

    await expect(
      service.handle(captureEvent({ eventType: 'BILLING.SUBSCRIPTION.CREATED' })),
    ).resolves.toBe('ignored');

    expect(ticketOrders.syncPaymentAsServer).not.toHaveBeenCalled();
    expect(model.rows.get('WH-1')).toMatchObject({ status: PayPalWebhookEventStatus.IGNORED });
  });

  it('devrait signaler une commande non résolue sans échouer', async () => {
    const { service, model, ticketOrders } = build({ resolvedOrderId: null });

    await expect(service.handle(captureEvent())).resolves.toBe('order_not_found');

    expect(ticketOrders.syncPaymentAsServer).not.toHaveBeenCalled();
    expect(model.rows.get('WH-1')).toMatchObject({
      status: PayPalWebhookEventStatus.IGNORED,
      failureCode: 'TICKET_ORDER_NOT_RESOLVED',
    });
  });

  it('devrait marquer FAILED et autoriser la reprise sur rejeu', async () => {
    const failing = build({ syncFails: true });
    await expect(failing.service.handle(captureEvent())).resolves.toBe('failed');
    expect(failing.model.rows.get('WH-1')).toMatchObject({
      status: PayPalWebhookEventStatus.FAILED,
      failureCode: 'Error',
    });

    // PayPal rejoue : l'événement précédemment en échec doit être repris.
    failing.ticketOrders.syncPaymentAsServer.mockResolvedValue({});
    await expect(failing.service.handle(captureEvent())).resolves.toBe('processed');
  });

  it("empêche un ancien propriétaire de bail d'écraser le résultat d'une reprise", async () => {
    const { service, model, ticketOrders } = build();
    let rejectFirst!: (error: Error) => void;
    const firstSync = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    ticketOrders.syncPaymentAsServer
      .mockImplementationOnce(() => firstSync)
      .mockResolvedValueOnce({});

    const staleWorker = service.handle(captureEvent());
    await Promise.resolve();
    await Promise.resolve();
    const row = model.rows.get('WH-1');
    expect(row).toBeDefined();
    row!.leaseExpiresAt = new Date(Date.now() - 1);

    await expect(service.handle(captureEvent())).resolves.toBe('processed');
    expect(row).toMatchObject({ status: PayPalWebhookEventStatus.PROCESSED });

    rejectFirst(new Error('stale worker failed'));
    await expect(staleWorker).resolves.toBe('failed');
    expect(row).toMatchObject({
      status: PayPalWebhookEventStatus.PROCESSED,
      failureCode: null,
      ticketOrderId: 'ticket-order-1',
    });
  });

  it('ne devrait jamais traiter le payload comme preuve de paiement', async () => {
    const { service, ticketOrders } = build();
    await service.handle(
      captureEvent({
        resource: {
          id: 'CAPTURE-1',
          status: 'COMPLETED',
          amount: { value: '9999.00' },
          supplementary_data: { related_ids: { order_id: 'PP-ORDER-1' } },
        },
      }),
    );
    // Aucun montant ni statut du payload n'est transmis : seule la commande l'est.
    expect(ticketOrders.syncPaymentAsServer).toHaveBeenCalledWith('ticket-order-1');
  });
});

describe('extractIdentifiers — les trois identifiants sont distincts', () => {
  it('devrait distinguer Capture ID et Order ID sur un événement de capture', () => {
    expect(extractIdentifiers(captureEvent())).toEqual({
      providerOrderId: 'PP-ORDER-1',
      providerCaptureId: 'CAPTURE-1',
      customId: 'ticket-order-1',
    });
  });

  it('devrait traiter resource.id comme Order ID sur CHECKOUT.ORDER.APPROVED', () => {
    const identifiers = extractIdentifiers(
      captureEvent({
        eventType: 'CHECKOUT.ORDER.APPROVED',
        resource: {
          id: 'PP-ORDER-2',
          purchase_units: [{ custom_id: 'ticket-order-2' }],
        },
      }),
    );
    expect(identifiers).toEqual({
      providerOrderId: 'PP-ORDER-2',
      providerCaptureId: null,
      customId: 'ticket-order-2',
    });
  });

  it('devrait rester tolérant à une ressource incomplète', () => {
    expect(extractIdentifiers(captureEvent({ resource: {} }))).toEqual({
      providerOrderId: null,
      providerCaptureId: null,
      customId: null,
    });
  });
});

describe('isHandledEventType — périmètre volontairement étroit', () => {
  it.each(HANDLED_EVENT_TYPES)('devrait gérer %s', (type) => {
    expect(isHandledEventType(type)).toBe(true);
  });

  it.each([
    'BILLING.SUBSCRIPTION.CREATED',
    'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    'CUSTOMER.DISPUTE.CREATED',
    '',
  ])('ne devrait pas gérer %p', (type) => {
    expect(isHandledEventType(type)).toBe(false);
  });

  it('devrait limiter le périmètre à quatre événements', () => {
    expect(HANDLED_EVENT_TYPES).toHaveLength(4);
  });
});
