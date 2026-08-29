import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Types } from 'mongoose';
import { PaymentsService } from './payments.service';
import { TicketType, TicketPurchase, TicketPurchaseStatus } from '../tickets/ticket.schema';
import { Event } from '../events/event.schema';
import { TicketsService } from '../tickets/tickets.service';
import { EmailsService } from '../emails/emails.service';
import { EventAccessService } from '../events/event-access.service';
import { TransactionService } from '../../shared/consistency/transactions/transaction.service';
import {
  StripePaymentFinalization,
  StripePaymentFinalizationStatus,
} from './stripe-payment-finalization.schema';
import { OperationAlreadyProcessingError } from '../../shared/consistency/errors/consistency.errors';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate', 'session'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

// Mock Stripe SDK avant tout import
const mockStripeCheckoutSessionsCreate = jest.fn();
const mockStripeWebhooksConstructEvent = jest.fn();
const mockStripeRefundsCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: { create: mockStripeCheckoutSessionsCreate },
    },
    webhooks: { constructEvent: mockStripeWebhooksConstructEvent },
    refunds: { create: mockStripeRefundsCreate },
  }));
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let ticketTypeModel: Record<string, jest.Mock>;
  let ticketPurchaseModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;
  let finalizationModel: Record<string, jest.Mock>;
  let ticketsService: { createPurchasesFromCheckout: jest.Mock };
  let emailsService: { sendTicketConfirmation: jest.Mock };
  let transactionService: { run: jest.Mock };

  const mockSession = {} as ClientSession;

  const ticketTypeId = '664f1a2b3c4d5e6f7a8b9c0d';
  const buyerId      = '664f1a2b3c4d5e6f7a8b9c0e';
  const organizerId  = '664f1a2b3c4d5e6f7a8b9c0f';
  const purchaseId   = '664f1a2b3c4d5e6f7a8b9c10';
  const eventId      = '664f1a2b3c4d5e6f7a8b9c11';
  const stripePi     = 'pi_test_stripe_xxxxxxxxxxx';

  const mockTicketType = (overrides = {}) => ({
    _id:      ticketTypeId,
    name:     'VIP',
    price:    5000,
    isFree:   false,
    quantity: 100,
    sold:     0,
    reserved: 0,
    event:    new Types.ObjectId(eventId),
    ...overrides,
  });

  const mockPurchase = (overrides = {}) => ({
    _id:                   purchaseId,
    event:                 { toString: () => eventId },
    status:                TicketPurchaseStatus.VALID,
    stripePaymentIntentId: stripePi,
    price:                 5000,
    ...overrides,
  });

  const mockEvent = (overrides = {}) => ({
    _id:       eventId,
    title:     'Gala Elintys',
    organizer: { toString: () => organizerId },
    status: 'published',
    discoverability: 'public',
    accessPolicy: { type: 'open' },
    admissionModes: ['paid_ticket'],
    ...overrides,
  });

  const mockFinalization = (overrides: Record<string, unknown> = {}) => ({
    stripePaymentIntentId: stripePi,
    status: StripePaymentFinalizationStatus.PROCESSING,
    ownerToken: 'default-owner-token',
    lockedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 600_000),
    purchaseIds: [],
    completedAt: null,
    ...overrides,
  });

  /**
   * Fait en sorte que `findOneAndUpdate(claim)` retourne un document dont
   * l'ownerToken correspond à celui généré par le service (émulé en capturant
   * la valeur écrite dans `$setOnInsert.ownerToken`).
   */
  const claimUpsertReturnsOwned = (finalizeCall: jest.Mock) => {
    finalizeCall.mockImplementation((_filter, update) => {
      const ownerToken = (update?.$setOnInsert?.ownerToken as string) ?? 'unknown';
      return makeChainable(mockFinalization({ ownerToken }));
    });
  };

  const transactionPassthrough = (run: jest.Mock) => {
    run.mockImplementation(async (_scope: string, work: (s: ClientSession) => Promise<unknown>) =>
      work(mockSession),
    );
  };

  beforeEach(async () => {
    ticketTypeModel = {
      findById: jest.fn(),
      findOne:  jest.fn(),
    };

    ticketPurchaseModel = {
      findOne:           jest.fn(),
      findById:          jest.fn(),
      findByIdAndUpdate: jest.fn(),
    };

    eventModel = {
      findById: jest.fn(),
    };
    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));

    finalizationModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    claimUpsertReturnsOwned(finalizationModel.findOneAndUpdate);

    ticketsService = { createPurchasesFromCheckout: jest.fn() };
    emailsService  = { sendTicketConfirmation: jest.fn().mockResolvedValue(undefined) };
    transactionService = { run: jest.fn() };
    transactionPassthrough(transactionService.run);

    mockStripeCheckoutSessionsCreate.mockReset();
    mockStripeWebhooksConstructEvent.mockReset();
    mockStripeRefundsCreate.mockReset();

    testingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              const map: Record<string, string | boolean> = {
                'stripe.secretKey':    'sk_test_xxx',
                'stripe.webhookSecret': 'whsec_xxx',
                'stripe.checkoutEnabled': true,
              };
              return map[key] ?? undefined;
            }),
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              const map: Record<string, string> = {
                'frontendUrl': 'http://localhost:3000',
              };
              return map[key] ?? 'value';
            }),
          },
        },
        { provide: getModelToken(TicketType.name),     useValue: ticketTypeModel },
        { provide: getModelToken(TicketPurchase.name), useValue: ticketPurchaseModel },
        { provide: getModelToken(Event.name),          useValue: eventModel },
        { provide: getModelToken(StripePaymentFinalization.name), useValue: finalizationModel },
        { provide: TicketsService,  useValue: ticketsService },
        { provide: EmailsService,   useValue: emailsService },
        {
          provide: EventAccessService,
          useValue: {
            buildActor: jest.fn().mockResolvedValue({
              userId: buyerId,
              email: 'participant@elintys.test',
            }),
          },
        },
        { provide: TransactionService, useValue: transactionService },
      ],
    }).compile();

    service = testingModule.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createCheckoutSession ──
  describe('createCheckoutSession', () => {
    const dto = { ticketTypeId, quantity: 2 };

    it('refuse toute nouvelle session lorsque le checkout payant est désactivé', async () => {
      Object.defineProperty(service, 'paidCheckoutEnabled', { value: false });

      await expect(service.createCheckoutSession(dto as never, buyerId))
        .rejects.toThrow(ServiceUnavailableException);
      expect(ticketTypeModel.findById).not.toHaveBeenCalled();
      expect(mockStripeCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it('retourne une sessionUrl Stripe valide', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      mockStripeCheckoutSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/xxx' });

      const result = await service.createCheckoutSession(dto as never, buyerId);

      expect(mockStripeCheckoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'payment',
          customer_email: 'participant@elintys.test',
          metadata: expect.objectContaining({
            ticketTypeId,
            quantity: '2',
            buyerId,
            guestEmail: 'participant@elintys.test',
          }),
        }),
      );
      expect(result.sessionUrl).toBe('https://checkout.stripe.com/pay/xxx');
    });

    it('lève BadRequestException si le billet est gratuit', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType({ isFree: true })));

      await expect(service.createCheckoutSession(dto as never, buyerId))
        .rejects.toThrow(BadRequestException);
    });

    it('lève BadRequestException si le stock est insuffisant', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType({ quantity: 1, sold: 1 })));

      await expect(service.createCheckoutSession({ ...dto, quantity: 2 } as never, buyerId))
        .rejects.toThrow(BadRequestException);
    });

    it('considère aussi les réservations actives dans la disponibilité historique', async () => {
      ticketTypeModel.findById.mockReturnValue(
        makeChainable(mockTicketType({ quantity: 10, sold: 3, reserved: 6 })),
      );

      await expect(service.createCheckoutSession(dto as never, buyerId)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockStripeCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("lève NotFoundException si le type de billet n'existe pas", async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.createCheckoutSession(dto as never, buyerId))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── handleWebhook ──
  describe('handleWebhook', () => {
    it("retourne l'événement Stripe si la signature est valide", () => {
      const event = { type: 'checkout.session.completed', data: { object: {} } };
      mockStripeWebhooksConstructEvent.mockReturnValue(event);

      const result = service.handleWebhook(Buffer.from('body'), 'sig');

      expect(mockStripeWebhooksConstructEvent).toHaveBeenCalledWith(
        expect.any(Buffer), 'sig', 'whsec_xxx',
      );
      expect(result).toBe(event);
    });

    it('lève BadRequestException si la signature est invalide', () => {
      mockStripeWebhooksConstructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      expect(() => service.handleWebhook(Buffer.from('body'), 'bad_sig'))
        .toThrow(BadRequestException);
    });
  });

  // ── processWebhookEvent — finalisation durable ──
  describe('processWebhookEvent', () => {
    const makeSession = (metaOverrides: Record<string, string | undefined> = {}) => ({
      id: 'cs_test_xxxxxxxxxxxxxxx',
      payment_intent: stripePi,
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 10000,
      currency: 'cad',
      metadata: {
        ticketTypeId,
        quantity:   '2',
        buyerId,
        guestEmail: 'marie@exemple.ca',
        guestName:  'Marie Dupuis',
        unitPrice:  '5000',
        ...metaOverrides,
      },
    });

    const createdPurchases = [
      { _id: new Types.ObjectId('664f1a2b3c4d5e6f7a8bAAAA'), qrCode: 'AAAA-BBBB-CCCC' },
      { _id: new Types.ObjectId('664f1a2b3c4d5e6f7a8bBBBB'), qrCode: 'DDDD-EEEE-FFFF' },
    ];

    it('crée les billets dans une transaction et envoie l\'email après commit', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);

      await service.processWebhookEvent({
        type: 'checkout.session.completed',
        data: { object: makeSession() as unknown as Record<string, unknown> },
      });

      // Claim atomique via upsert
      expect(finalizationModel.findOneAndUpdate).toHaveBeenCalledWith(
        { stripePaymentIntentId: stripePi },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            status: StripePaymentFinalizationStatus.PROCESSING,
            ownerToken: expect.any(String),
          }),
        }),
        expect.objectContaining({ upsert: true, new: true }),
      );

      // Transaction unique englobant création + transition SUCCEEDED
      expect(transactionService.run).toHaveBeenCalledTimes(1);
      expect(transactionService.run).toHaveBeenCalledWith('stripe-webhook', expect.any(Function));

      // createPurchasesFromCheckout reçoit explicitement la ClientSession
      expect(ticketsService.createPurchasesFromCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketTypeId,
          quantity: 2,
          price: 5000,
          stripePaymentIntentId: stripePi,
        }),
        mockSession,
      );

      // Transition PROCESSING → SUCCEEDED dans la même session
      expect(finalizationModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePaymentIntentId: stripePi,
          status: StripePaymentFinalizationStatus.PROCESSING,
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: StripePaymentFinalizationStatus.SUCCEEDED,
            purchaseIds: expect.any(Array),
          }),
        }),
        { session: mockSession },
      );

      // Email envoyé APRÈS le commit (hors transaction)
      expect(emailsService.sendTicketConfirmation).toHaveBeenCalledWith(
        'marie@exemple.ca',
        expect.objectContaining({
          eventTitle: 'Gala Elintys',
          quantity: 2,
          totalPrice: 10000,
          qrCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'],
        }),
      );

      // Pas de suppression de la finalization (transaction OK)
      expect(finalizationModel.deleteOne).not.toHaveBeenCalled();
    });

    it("ignore les événements d'un type différent", async () => {
      await service.processWebhookEvent({
        type: 'payment_intent.created',
        data: { object: {} },
      });

      expect(ticketsService.createPurchasesFromCheckout).not.toHaveBeenCalled();
      expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejeu : finalization déjà SUCCEEDED → retourne sans deuxième effet', async () => {
      finalizationModel.findOneAndUpdate.mockReturnValueOnce(
        makeChainable(mockFinalization({ status: StripePaymentFinalizationStatus.SUCCEEDED })),
      );
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));

      await service.processWebhookEvent({
        type: 'checkout.session.completed',
        data: { object: makeSession() as unknown as Record<string, unknown> },
      });

      expect(transactionService.run).not.toHaveBeenCalled();
      expect(ticketsService.createPurchasesFromCheckout).not.toHaveBeenCalled();
      expect(emailsService.sendTicketConfirmation).not.toHaveBeenCalled();
    });

    it('concurrence : autre instance a un lease actif → OperationAlreadyProcessingError', async () => {
      // Doc existe déjà PROCESSING avec un autre ownerToken, lease non expiré
      finalizationModel.findOneAndUpdate.mockReturnValueOnce(
        makeChainable(
          mockFinalization({
            status: StripePaymentFinalizationStatus.PROCESSING,
            ownerToken: 'other-instance-token',
            leaseExpiresAt: new Date(Date.now() + 300_000),
          }),
        ),
      );
      // Tentative de re-claim sur lease expiré → aucun match
      finalizationModel.findOneAndUpdate.mockReturnValueOnce(makeChainable(null));
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));

      await expect(
        service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: { object: makeSession() as unknown as Record<string, unknown> },
        }),
      ).rejects.toBeInstanceOf(OperationAlreadyProcessingError);

      expect(transactionService.run).not.toHaveBeenCalled();
    });

    it('traduit une collision E11000 du claim en conflit applicatif', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      finalizationModel.findOneAndUpdate.mockReturnValueOnce({
        lean: jest.fn().mockRejectedValue({ code: 11000 }),
      });
      finalizationModel.findOne.mockReturnValue(
        makeChainable(mockFinalization({ ownerToken: 'other-instance-token' })),
      );
      finalizationModel.findOneAndUpdate.mockReturnValueOnce(makeChainable(null));

      await expect(
        service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: { object: makeSession() as unknown as Record<string, unknown> },
        }),
      ).rejects.toBeInstanceOf(OperationAlreadyProcessingError);

      expect(transactionService.run).not.toHaveBeenCalled();
    });

    it('re-claim si lease expiré → procède à la finalisation', async () => {
      // Doc existe déjà PROCESSING avec un autre ownerToken, lease expiré
      finalizationModel.findOneAndUpdate.mockReturnValueOnce(
        makeChainable(
          mockFinalization({
            status: StripePaymentFinalizationStatus.PROCESSING,
            ownerToken: 'crashed-instance-token',
            leaseExpiresAt: new Date(Date.now() - 10_000),
          }),
        ),
      );
      // Re-claim atomique réussi
      finalizationModel.findOneAndUpdate.mockReturnValueOnce(
        makeChainable(mockFinalization({ ownerToken: 'new-token' })),
      );
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);

      await service.processWebhookEvent({
        type: 'checkout.session.completed',
        data: { object: makeSession() as unknown as Record<string, unknown> },
      });

      expect(transactionService.run).toHaveBeenCalledTimes(1);
      expect(ticketsService.createPurchasesFromCheckout).toHaveBeenCalled();
    });

    it('stock insuffisant → transaction rollback + suppression du PROCESSING', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      const stockError = new Error('INSUFFICIENT_CAPACITY');
      ticketsService.createPurchasesFromCheckout.mockRejectedValue(stockError);

      await expect(
        service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: { object: makeSession() as unknown as Record<string, unknown> },
        }),
      ).rejects.toBe(stockError);

      // La finalization PROCESSING est supprimée pour permettre le retry Stripe
      expect(finalizationModel.deleteOne).toHaveBeenCalledWith(
        expect.objectContaining({
          stripePaymentIntentId: stripePi,
          status: StripePaymentFinalizationStatus.PROCESSING,
        }),
      );
      expect(emailsService.sendTicketConfirmation).not.toHaveBeenCalled();
    });

    it('transaction rollback si la transition SUCCEEDED échoue (lease volé)', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);
      // Simule qu'entre notre claim et notre transition, un autre owner a repris
      finalizationModel.updateOne.mockResolvedValue({ modifiedCount: 0 });

      await expect(
        service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: { object: makeSession() as unknown as Record<string, unknown> },
        }),
      ).rejects.toBeInstanceOf(OperationAlreadyProcessingError);

      expect(finalizationModel.deleteOne).toHaveBeenCalled();
      expect(emailsService.sendTicketConfirmation).not.toHaveBeenCalled();
    });

    describe('validation metadata', () => {
      const runWithMeta = async (metaOverrides: Record<string, string | undefined>) =>
        service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_test_xxx',
              payment_intent: stripePi,
              mode: 'payment',
              payment_status: 'paid',
              amount_total: 10000,
              currency: 'cad',
              metadata: {
                ticketTypeId,
                quantity: '2',
                buyerId,
                guestEmail: 'marie@exemple.ca',
                unitPrice: '5000',
                ...metaOverrides,
              },
            } as unknown as Record<string, unknown>,
          },
        });

      it.each([
        ['ticketTypeId absent', { ticketTypeId: undefined }],
        ['quantity absent', { quantity: undefined }],
        ['unitPrice absent', { unitPrice: undefined }],
        ['ticketTypeId non-ObjectId', { ticketTypeId: 'not-an-object-id' }],
        ['quantity NaN', { quantity: 'abc' }],
        ['quantity partiellement numérique', { quantity: '2x' }],
        ['quantity zéro', { quantity: '0' }],
        ['quantity > MAX', { quantity: '999' }],
        ['unitPrice négatif', { unitPrice: '-1' }],
        ['buyerId non-ObjectId', { buyerId: 'not-object-id', guestEmail: undefined }],
        ['ni buyerId ni guestEmail', { buyerId: undefined, guestEmail: undefined }],
      ])('ignore la session si %s', async (_label, meta) => {
        ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));

        await runWithMeta(meta);

        expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(transactionService.run).not.toHaveBeenCalled();
        expect(ticketsService.createPurchasesFromCheckout).not.toHaveBeenCalled();
      });

      it('ignore la session si payment_intent absent', async () => {
        await service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_test_xxx',
              payment_intent: null,
              metadata: { ticketTypeId, quantity: '2', unitPrice: '5000', buyerId },
            } as unknown as Record<string, unknown>,
          },
        });

        expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
      });

      it('ignore la session si ticketType introuvable en DB', async () => {
        ticketTypeModel.findById.mockReturnValue(makeChainable(null));

        await runWithMeta({});

        expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(transactionService.run).not.toHaveBeenCalled();
      });

      it('ignore la session si prix metadata != prix DB (dérive/altération)', async () => {
        ticketTypeModel.findById.mockReturnValue(
          makeChainable(mockTicketType({ price: 7500 })),
        );

        await runWithMeta({ unitPrice: '5000' });

        expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(transactionService.run).not.toHaveBeenCalled();
      });

      it('ignore la session si ticketType est gratuit (routage incorrect)', async () => {
        ticketTypeModel.findById.mockReturnValue(
          makeChainable(mockTicketType({ isFree: true })),
        );

        await runWithMeta({});

        expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
      });

      it.each([
        ['paiement non réglé', { payment_status: 'unpaid' }],
        ['montant Stripe incohérent', { amount_total: 9999 }],
        ['devise incohérente', { currency: 'usd' }],
        ['mode non paiement', { mode: 'subscription' }],
      ])('ignore la session si %s', async (_label, override) => {
        ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));

        await service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: { object: { ...makeSession(), ...override } as unknown as Record<string, unknown> },
        });

        expect(finalizationModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(transactionService.run).not.toHaveBeenCalled();
      });
    });

    describe('email post-commit', () => {
      it('l\'email est envoyé APRÈS la fin de la transaction', async () => {
        ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
        ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);

        // Instrumente l'ordre : capturer le moment où l'email est envoyé
        const events: string[] = [];
        transactionService.run.mockImplementation(async (_scope, work) => {
          events.push('tx-start');
          const result = await work(mockSession);
          events.push('tx-commit');
          return result;
        });
        emailsService.sendTicketConfirmation.mockImplementation(async () => {
          events.push('email-sent');
        });

        await service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: { object: makeSession() as unknown as Record<string, unknown> },
        });

        expect(events).toEqual(['tx-start', 'tx-commit', 'email-sent']);
      });

      it('un échec email ne rollback pas et ne relance pas', async () => {
        ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
        ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);
        emailsService.sendTicketConfirmation.mockRejectedValue(new Error('SMTP down'));

        // Ne doit pas throw — les billets sont finalisés
        await expect(
          service.processWebhookEvent({
            type: 'checkout.session.completed',
            data: { object: makeSession() as unknown as Record<string, unknown> },
          }),
        ).resolves.toBeUndefined();

        // Pas de suppression de finalization (l'échec est hors transaction)
        expect(finalizationModel.deleteOne).not.toHaveBeenCalled();
      });

      it('aucun email si guestEmail absent (buyer authentifié uniquement)', async () => {
        ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
        ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);

        await service.processWebhookEvent({
          type: 'checkout.session.completed',
          data: {
            object: makeSession({ guestEmail: undefined }) as unknown as Record<string, unknown>,
          },
        });

        expect(emailsService.sendTicketConfirmation).not.toHaveBeenCalled();
      });
    });

    describe('confidentialité des logs', () => {
      it("ne logge jamais le stripePaymentIntentId brut, ni le session.id brut", async () => {
        const captured: string[] = [];
        const originalWarn = Logger.prototype.warn;
        const originalError = Logger.prototype.error;
        const originalLog = Logger.prototype.log;
        Logger.prototype.warn = function (msg: unknown) { captured.push(String(msg)); };
        Logger.prototype.error = function (msg: unknown) { captured.push(String(msg)); };
        Logger.prototype.log = function (msg: unknown) { captured.push(String(msg)); };

        try {
          ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
          ticketsService.createPurchasesFromCheckout.mockResolvedValue(createdPurchases);

          await service.processWebhookEvent({
            type: 'checkout.session.completed',
            data: { object: makeSession() as unknown as Record<string, unknown> },
          });

          const joined = captured.join('\n');
          expect(joined).not.toContain(stripePi);
          expect(joined).not.toContain('cs_test_xxxxxxxxxxxxxxx');
          // Un log critique doit être présent (succeeded)
          expect(joined).toMatch(/stripe-webhook/);
        } finally {
          Logger.prototype.warn = originalWarn;
          Logger.prototype.error = originalError;
          Logger.prototype.log = originalLog;
        }
      });

      it("ne logge pas le PI brut sur metadata invalide", async () => {
        const captured: string[] = [];
        const originalWarn = Logger.prototype.warn;
        Logger.prototype.warn = function (msg: unknown) { captured.push(String(msg)); };

        try {
          await service.processWebhookEvent({
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_test_leaky',
                payment_intent: stripePi,
                metadata: { ticketTypeId: 'bad', quantity: '2', unitPrice: '5000', buyerId },
              } as unknown as Record<string, unknown>,
            },
          });

          const joined = captured.join('\n');
          expect(joined).not.toContain(stripePi);
          expect(joined).not.toContain('cs_test_leaky');
        } finally {
          Logger.prototype.warn = originalWarn;
        }
      });
    });
  });

  // ── refundTicket ──
  describe('refundTicket', () => {
    it('devrait rembourser un billet valide avec Stripe', async () => {
      ticketPurchaseModel.findById.mockReturnValue(makeChainable(mockPurchase()));
      eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
      mockStripeRefundsCreate.mockResolvedValue({ id: 're_test_xxx' });
      ticketPurchaseModel.findByIdAndUpdate.mockReturnValue(
        makeChainable({ ...mockPurchase(), status: TicketPurchaseStatus.REFUNDED }),
      );

      const result = await service.refundTicket(purchaseId, organizerId);

      expect(mockStripeRefundsCreate).toHaveBeenCalledWith({
        payment_intent: stripePi,
        amount: 5000,
      });
      expect(result.status).toBe(TicketPurchaseStatus.REFUNDED);
    });

    it('devrait rembourser un billet gratuit sans appeler Stripe', async () => {
      ticketPurchaseModel.findById.mockReturnValue(
        makeChainable(mockPurchase({ stripePaymentIntentId: undefined })),
      );
      eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
      ticketPurchaseModel.findByIdAndUpdate.mockReturnValue(
        makeChainable({ ...mockPurchase(), status: TicketPurchaseStatus.REFUNDED }),
      );

      const result = await service.refundTicket(purchaseId, organizerId);

      expect(mockStripeRefundsCreate).not.toHaveBeenCalled();
      expect(result.status).toBe(TicketPurchaseStatus.REFUNDED);
    });

    it("devrait lever ForbiddenException si l'organisateur ne correspond pas", async () => {
      ticketPurchaseModel.findById.mockReturnValue(makeChainable(mockPurchase()));
      eventModel.findById.mockReturnValue(
        makeChainable({ ...mockEvent(), organizer: { toString: () => 'other-organizer-id' } }),
      );

      await expect(service.refundTicket(purchaseId, organizerId))
        .rejects.toThrow(ForbiddenException);
    });

    it('devrait lever BadRequestException si le billet est déjà remboursé', async () => {
      ticketPurchaseModel.findById.mockReturnValue(
        makeChainable(mockPurchase({ status: TicketPurchaseStatus.REFUNDED })),
      );
      eventModel.findById.mockReturnValue(makeChainable(mockEvent()));

      await expect(service.refundTicket(purchaseId, organizerId))
        .rejects.toThrow(BadRequestException);
    });

    it("devrait lever BadRequestException si le billet n'est pas valide (statut: used)", async () => {
      ticketPurchaseModel.findById.mockReturnValue(
        makeChainable(mockPurchase({ status: TicketPurchaseStatus.USED })),
      );
      eventModel.findById.mockReturnValue(makeChainable(mockEvent()));

      await expect(service.refundTicket(purchaseId, organizerId))
        .rejects.toThrow(BadRequestException);
    });

    it('devrait lever NotFoundException si le billet est introuvable', async () => {
      ticketPurchaseModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.refundTicket(purchaseId, organizerId))
        .rejects.toThrow(NotFoundException);
    });

    it('devrait lever ServiceUnavailableException si billet payant et Stripe non configuré', async () => {
      testingModule = await Test.createTestingModule({
        providers: [
          PaymentsService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue(undefined),
              getOrThrow: jest.fn().mockReturnValue('http://localhost:3000'),
            },
          },
          { provide: getModelToken(TicketType.name),     useValue: ticketTypeModel },
          { provide: getModelToken(TicketPurchase.name), useValue: ticketPurchaseModel },
          { provide: getModelToken(Event.name),          useValue: eventModel },
          { provide: getModelToken(StripePaymentFinalization.name), useValue: finalizationModel },
          { provide: TicketsService,  useValue: ticketsService },
          { provide: EmailsService,   useValue: emailsService },
          { provide: EventAccessService, useValue: { buildActor: jest.fn() } },
          { provide: TransactionService, useValue: transactionService },
        ],
      }).compile();

      const serviceNoStripe = testingModule.get<PaymentsService>(PaymentsService);
      ticketPurchaseModel.findById.mockReturnValue(makeChainable(mockPurchase()));
      eventModel.findById.mockReturnValue(makeChainable(mockEvent()));

      await expect(serviceNoStripe.refundTicket(purchaseId, organizerId))
        .rejects.toThrow(ServiceUnavailableException);
    });
  });

  // ── handleWebhook — Stripe guard ──
  describe('handleWebhook — Stripe guard', () => {
    it('devrait lever ServiceUnavailableException si Stripe non configuré', async () => {
      testingModule = await Test.createTestingModule({
        providers: [
          PaymentsService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue(undefined),
              getOrThrow: jest.fn().mockReturnValue('http://localhost:3000'),
            },
          },
          { provide: getModelToken(TicketType.name),     useValue: ticketTypeModel },
          { provide: getModelToken(TicketPurchase.name), useValue: ticketPurchaseModel },
          { provide: getModelToken(Event.name),          useValue: eventModel },
          { provide: getModelToken(StripePaymentFinalization.name), useValue: finalizationModel },
          { provide: TicketsService,  useValue: ticketsService },
          { provide: EmailsService,   useValue: emailsService },
          { provide: EventAccessService, useValue: { buildActor: jest.fn() } },
          { provide: TransactionService, useValue: transactionService },
        ],
      }).compile();

      const serviceNoStripe = testingModule.get<PaymentsService>(PaymentsService);

      expect(() => serviceNoStripe.handleWebhook(Buffer.from('body'), 'sig'))
        .toThrow(ServiceUnavailableException);
    });
  });
});
