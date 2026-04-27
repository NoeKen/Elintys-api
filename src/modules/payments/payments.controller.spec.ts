import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

const mockPaymentsService = {
  createCheckoutSession: jest.fn(),
  handleWebhook:         jest.fn(),
  processWebhookEvent:   jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('PaymentsController', () => {
  let controller: PaymentsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: mockPaymentsService }],
    }).compile();

    controller = module.get<PaymentsController>(PaymentsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /payments/checkout ──
  describe('createCheckoutSession', () => {
    it('délègue à paymentsService.createCheckoutSession avec user.sub et retourne la sessionUrl', async () => {
      const dto = { ticketTypeId: 'tt-id', quantity: 2 };
      mockPaymentsService.createCheckoutSession.mockResolvedValue({
        sessionUrl: 'https://checkout.stripe.com/pay/xxx',
      });

      const result = await controller.createCheckoutSession(dto as never, mockUser as never);

      expect(mockPaymentsService.createCheckoutSession).toHaveBeenCalledWith(dto, mockUser.sub);
      expect(result.sessionUrl).toBe('https://checkout.stripe.com/pay/xxx');
    });
  });

  // ── POST /payments/webhook ──
  describe('webhook', () => {
    const makeReq = (overrides = {}) => ({
      headers: { 'stripe-signature': 'sig_test' },
      rawBody: Buffer.from('{"type":"checkout.session.completed"}'),
      ...overrides,
    });

    it('valide la signature, traite l\'événement et retourne { received: true }', async () => {
      const event = { type: 'checkout.session.completed', data: { object: {} } };
      mockPaymentsService.handleWebhook.mockReturnValue(event);
      mockPaymentsService.processWebhookEvent.mockResolvedValue(undefined);

      const result = await controller.webhook(makeReq() as never);

      expect(mockPaymentsService.handleWebhook).toHaveBeenCalledWith(
        expect.any(Buffer), 'sig_test',
      );
      expect(mockPaymentsService.processWebhookEvent).toHaveBeenCalledWith(event);
      expect(result).toEqual({ received: true });
    });

    it("lève BadRequestException si l'en-tête stripe-signature est absent", async () => {
      await expect(
        controller.webhook(makeReq({ headers: {} }) as never),
      ).rejects.toThrow(BadRequestException);

      expect(mockPaymentsService.handleWebhook).not.toHaveBeenCalled();
    });

    it('lève BadRequestException si le rawBody est absent', async () => {
      await expect(
        controller.webhook(makeReq({ rawBody: undefined }) as never),
      ).rejects.toThrow(BadRequestException);

      expect(mockPaymentsService.handleWebhook).not.toHaveBeenCalled();
    });
  });
});
