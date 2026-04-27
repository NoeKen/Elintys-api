import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { TicketType, TicketPurchase } from '../tickets/ticket.schema';
import { TicketsService } from '../tickets/tickets.service';
import { EmailsService } from '../emails/emails.service';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

// Mock Stripe SDK avant tout import
const mockStripeCheckoutSessionsCreate = jest.fn();
const mockStripeWebhooksConstructEvent = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: { create: mockStripeCheckoutSessionsCreate },
    },
    webhooks: { constructEvent: mockStripeWebhooksConstructEvent },
  }));
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let ticketTypeModel: Record<string, jest.Mock>;
  let ticketPurchaseModel: Record<string, jest.Mock>;
  let ticketsService: { createPurchasesFromCheckout: jest.Mock };
  let emailsService: { sendTicketConfirmation: jest.Mock };

  const ticketTypeId = '664f1a2b3c4d5e6f7a8b9c0d';
  const buyerId      = '664f1a2b3c4d5e6f7a8b9c0e';

  const mockTicketType = (overrides = {}) => ({
    _id:      ticketTypeId,
    name:     'VIP',
    price:    5000,
    isFree:   false,
    quantity: 100,
    sold:     0,
    event:    'event-id',
    ...overrides,
  });

  beforeEach(async () => {
    ticketTypeModel = {
      findById: jest.fn(),
      findOne:  jest.fn(),
    };

    ticketPurchaseModel = {
      findOne: jest.fn(),
    };

    ticketsService = { createPurchasesFromCheckout: jest.fn() };
    emailsService  = { sendTicketConfirmation:       jest.fn().mockResolvedValue(undefined) };

    mockStripeCheckoutSessionsCreate.mockReset();
    mockStripeWebhooksConstructEvent.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              const map: Record<string, string> = {
                'stripe.secretKey':    'sk_test_xxx',
                'stripe.webhookSecret': 'whsec_xxx',
                'frontendUrl':          'http://localhost:3000',
              };
              return map[key] ?? 'value';
            }),
          },
        },
        { provide: getModelToken(TicketType.name),     useValue: ticketTypeModel },
        { provide: getModelToken(TicketPurchase.name), useValue: ticketPurchaseModel },
        { provide: TicketsService,  useValue: ticketsService },
        { provide: EmailsService,   useValue: emailsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createCheckoutSession ──
  describe('createCheckoutSession', () => {
    const dto = { ticketTypeId, quantity: 2 };

    it('retourne une sessionUrl Stripe valide', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
      mockStripeCheckoutSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/xxx' });

      const result = await service.createCheckoutSession(dto as never, buyerId);

      expect(mockStripeCheckoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'payment',
          metadata: expect.objectContaining({ ticketTypeId, quantity: '2', buyerId }),
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

  // ── processWebhookEvent ──
  describe('processWebhookEvent', () => {
    const makeSession = (meta: Record<string, string> = {}) => ({
      id:              'cs_test_xxx',
      payment_intent:  'pi_test_xxx',
      metadata: {
        ticketTypeId,
        quantity:   '2',
        buyerId,
        guestEmail: 'marie@exemple.ca',
        guestName:  'Marie Dupuis',
        unitPrice:  '5000',
        ...meta,
      },
    });

    it('crée les billets et envoie un courriel de confirmation', async () => {
      ticketPurchaseModel.findOne.mockReturnValue(makeChainable(null));
      ticketsService.createPurchasesFromCheckout.mockResolvedValue([
        { qrCode: 'AAAA-BBBB-CCCC' },
        { qrCode: 'DDDD-EEEE-FFFF' },
      ]);
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));

      await service.processWebhookEvent({
        type: 'checkout.session.completed',
        data: { object: makeSession() as unknown as Record<string, unknown> },
      });

      expect(ticketsService.createPurchasesFromCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ ticketTypeId, quantity: 2, stripePaymentIntentId: 'pi_test_xxx' }),
      );
      expect(emailsService.sendTicketConfirmation).toHaveBeenCalledWith(
        'marie@exemple.ca',
        expect.objectContaining({ quantity: 2, qrCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'] }),
      );
    });

    it("ignore les événements d'un type différent", async () => {
      await service.processWebhookEvent({
        type: 'payment_intent.created',
        data: { object: {} },
      });

      expect(ticketsService.createPurchasesFromCheckout).not.toHaveBeenCalled();
    });

    it('ignore les sessions déjà traitées (idempotence)', async () => {
      ticketPurchaseModel.findOne.mockReturnValue(makeChainable({ _id: 'existing' }));

      await service.processWebhookEvent({
        type: 'checkout.session.completed',
        data: { object: makeSession() as unknown as Record<string, unknown> },
      });

      expect(ticketsService.createPurchasesFromCheckout).not.toHaveBeenCalled();
    });
  });
});
