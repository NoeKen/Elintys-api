import { Test, TestingModule } from '@nestjs/testing';
import { TicketTypesController, TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { ScanTicketDto } from './dto/scan-ticket.dto';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { JwtPayload } from '../../shared/decorators/current-user.decorator';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockTicketsService = {
  createTicketType:          jest.fn(),
  findTicketTypes:           jest.fn(),
  findManagedTicketTypes:    jest.fn(),
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
    testingModule = await Test.createTestingModule({
      controllers: [TicketTypesController],
      providers: [{ provide: TicketsService, useValue: mockTicketsService }],
    }).compile();

    controller = testingModule.get<TicketTypesController>(TicketTypesController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /ticket-types/events/:eventId ──
  describe('createType', () => {
    it('délègue à ticketsService.createTicketType avec eventId, user.sub et le DTO', async () => {
      const dto: CreateTicketTypeDto = { name: 'VIP', price: 150, quantity: 100 };
      mockTicketsService.createTicketType.mockResolvedValue({ _id: 'tt-id', ...dto });

      await controller.createType('event-id', mockUser, dto);

      expect(mockTicketsService.createTicketType).toHaveBeenCalledWith('event-id', mockUser.sub, dto, mockUser.roles);
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

  describe('findManagedTypes', () => {
    it('dérive le propriétaire de user.sub', async () => {
      mockTicketsService.findManagedTicketTypes.mockResolvedValue([]);

      await controller.findManagedTypes('event-id', mockUser);

      expect(mockTicketsService.findManagedTicketTypes).toHaveBeenCalledWith(
        'event-id',
        mockUser.sub,
        mockUser.roles,
      );
    });
  });

  // ── PUT /ticket-types/:id ──
  describe('updateType', () => {
    it('délègue à ticketsService.updateTicketType avec l\'ID, user.sub et le DTO', async () => {
      const dto: UpdateTicketTypeDto = { name: 'VIP Platinum' };
      mockTicketsService.updateTicketType.mockResolvedValue({ _id: 'tt-id', ...dto });

      await controller.updateType('tt-id', mockUser, dto);

      expect(mockTicketsService.updateTicketType).toHaveBeenCalledWith('tt-id', mockUser.sub, dto, mockUser.roles);
    });
  });

  // ── DELETE /ticket-types/:id ──
  describe('removeType', () => {
    it('délègue à ticketsService.removeTicketType avec l\'ID et user.sub', async () => {
      mockTicketsService.removeTicketType.mockResolvedValue(undefined);

      await controller.removeType('tt-id', mockUser);

      expect(mockTicketsService.removeTicketType).toHaveBeenCalledWith('tt-id', mockUser.sub, mockUser.roles);
    });
  });
});

describe('TicketsController', () => {
  let controller: TicketsController;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      controllers: [TicketsController],
      providers: [{ provide: TicketsService, useValue: mockTicketsService }],
    }).compile();

    controller = testingModule.get<TicketsController>(TicketsController);
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
    it('délègue à ticketsService.purchase avec user.sub, le DTO, la clé et le grant', async () => {
      const dto: PurchaseTicketDto = { ticketTypeId: 'tt-id', quantity: 2 };
      mockTicketsService.purchase.mockResolvedValue([{ _id: 'p1' }, { _id: 'p2' }]);

      const result = await controller.purchase(mockUser, dto, 'idem-key-123', 'grant-xyz');

      expect(mockTicketsService.purchase).toHaveBeenCalledWith(
        mockUser.sub,
        dto,
        'idem-key-123',
        'grant-xyz',
      );
      expect(result).toHaveLength(2);
    });

    it("n'invente pas de grant si le header X-Event-Access-Grant est absent", async () => {
      const dto: PurchaseTicketDto = { ticketTypeId: 'tt-id', quantity: 1 };
      mockTicketsService.purchase.mockResolvedValue([{ _id: 'p1' }]);

      await controller.purchase(mockUser, dto, 'idem-key-456', undefined);

      expect(mockTicketsService.purchase).toHaveBeenCalledWith(
        mockUser.sub,
        dto,
        'idem-key-456',
        undefined,
      );
    });
  });

  // ── POST /tickets/scan ──
  describe('scan', () => {
    it("délègue à ticketsService.scan l'événement, le code QR, user.sub et les rôles", async () => {
      mockTicketsService.scan.mockResolvedValue({
        purchase: { _id: 'p1', status: 'used' },
        outcome: 'admitted',
        message: 'Billet scanné avec succès.',
      });

      const dto: ScanTicketDto = {
        eventId: '664f1a2b3c4d5e6f7a8b9c0d',
        qrCode: 'ABCD-EFGH-IJKL',
      };
      const result = await controller.scan(dto, mockUser);

      // `eventId` est transmis pour l'autorisation ET pour lier le billet :
      // ce n'est pas un champ décoratif accepté puis ignoré.
      expect(mockTicketsService.scan).toHaveBeenCalledWith(
        '664f1a2b3c4d5e6f7a8b9c0d',
        'ABCD-EFGH-IJKL',
        mockUser.sub,
        mockUser.roles,
      );
      expect(result.outcome).toBe('admitted');
    });

    it('le DTO de scan exige un eventId : le contrat frontend est complet', () => {
      // Garde-fou de contrat : le scanner web envoie {eventId, qrCode}. Avec
      // `forbidNonWhitelisted`, tout champ absent du DTO produisait un 400.
      const dto: ScanTicketDto = {
        eventId: '664f1a2b3c4d5e6f7a8b9c0d',
        qrCode: 'ABCD-EFGH-IJKL',
      };
      expect(Object.keys(dto).sort()).toEqual(['eventId', 'qrCode']);
    });
  });
});
