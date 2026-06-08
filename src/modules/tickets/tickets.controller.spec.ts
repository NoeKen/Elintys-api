import { Test, TestingModule } from '@nestjs/testing';
import { TicketTypesController, TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { ScanTicketDto } from './dto/scan-ticket.dto';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { JwtPayload } from '../../shared/decorators/current-user.decorator';

const mockTicketsService = {
  createTicketType:          jest.fn(),
  findTicketTypes:           jest.fn(),
  updateTicketType:          jest.fn(),
  removeTicketType:          jest.fn(),
  findMyTickets:             jest.fn(),
  purchase:                  jest.fn(),
  scan:                      jest.fn(),
  linkGuestPurchases:        jest.fn(),
  createPurchasesFromCheckout: jest.fn(),
};

const mockUser: JwtPayload = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('TicketTypesController', () => {
  let controller: TicketTypesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketTypesController],
      providers: [{ provide: TicketsService, useValue: mockTicketsService }],
    }).compile();

    controller = module.get<TicketTypesController>(TicketTypesController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /ticket-types/events/:eventId ──
  describe('createType', () => {
    it('délègue à ticketsService.createTicketType avec eventId, user.sub et le DTO', async () => {
      const dto: CreateTicketTypeDto = { name: 'VIP', price: 150, quantity: 100 };
      mockTicketsService.createTicketType.mockResolvedValue({ _id: 'tt-id', ...dto });

      await controller.createType('event-id', mockUser, dto);

      expect(mockTicketsService.createTicketType).toHaveBeenCalledWith('event-id', mockUser.sub, dto);
    });
  });

  // ── GET /ticket-types/events/:eventId ──
  describe('findTypes', () => {
    it("délègue à ticketsService.findTicketTypes avec l'eventId", async () => {
      mockTicketsService.findTicketTypes.mockResolvedValue([]);

      await controller.findTypes('event-id');

      expect(mockTicketsService.findTicketTypes).toHaveBeenCalledWith('event-id');
    });
  });

  // ── PUT /ticket-types/:id ──
  describe('updateType', () => {
    it('délègue à ticketsService.updateTicketType avec l\'ID, user.sub et le DTO', async () => {
      const dto: UpdateTicketTypeDto = { name: 'VIP Platinum' };
      mockTicketsService.updateTicketType.mockResolvedValue({ _id: 'tt-id', ...dto });

      await controller.updateType('tt-id', mockUser, dto);

      expect(mockTicketsService.updateTicketType).toHaveBeenCalledWith('tt-id', mockUser.sub, dto);
    });
  });

  // ── DELETE /ticket-types/:id ──
  describe('removeType', () => {
    it('délègue à ticketsService.removeTicketType avec l\'ID et user.sub', async () => {
      mockTicketsService.removeTicketType.mockResolvedValue(undefined);

      await controller.removeType('tt-id', mockUser);

      expect(mockTicketsService.removeTicketType).toHaveBeenCalledWith('tt-id', mockUser.sub);
    });
  });
});

describe('TicketsController', () => {
  let controller: TicketsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [{ provide: TicketsService, useValue: mockTicketsService }],
    }).compile();

    controller = module.get<TicketsController>(TicketsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── GET /tickets/my ──
  describe('myTickets', () => {
    it('délègue à ticketsService.findMyTickets avec user.sub', async () => {
      mockTicketsService.findMyTickets.mockResolvedValue([]);

      await controller.myTickets(mockUser);

      expect(mockTicketsService.findMyTickets).toHaveBeenCalledWith(mockUser.sub);
    });
  });

  // ── POST /tickets/purchase ──
  describe('purchase', () => {
    it('délègue à ticketsService.purchase avec user.sub et le DTO', async () => {
      const dto: PurchaseTicketDto = { ticketTypeId: 'tt-id', quantity: 2 };
      mockTicketsService.purchase.mockResolvedValue([{ _id: 'p1' }, { _id: 'p2' }]);

      const result = await controller.purchase(mockUser, dto);

      expect(mockTicketsService.purchase).toHaveBeenCalledWith(mockUser.sub, dto);
      expect(result).toHaveLength(2);
    });
  });

  // ── POST /tickets/scan ──
  describe('scan', () => {
    it('délègue à ticketsService.scan avec le code QR du body et user.sub', async () => {
      mockTicketsService.scan.mockResolvedValue({
        purchase: { _id: 'p1', status: 'valid' },
        message: 'Billet scanné avec succès.',
      });

      const dto: ScanTicketDto = { qrCode: 'ABCD-EFGH-IJKL' };
      const result = await controller.scan(dto, mockUser);

      expect(mockTicketsService.scan).toHaveBeenCalledWith('ABCD-EFGH-IJKL', mockUser.sub);
      expect(result.message).toBe('Billet scanné avec succès.');
    });
  });
});
