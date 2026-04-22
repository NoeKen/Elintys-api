import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { TicketsService } from './tickets.service';
import { TicketType, TicketPurchase } from './ticket.schema';
import { Event } from '../events/event.schema';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('TicketsService', () => {
  let service: TicketsService;
  let ticketTypeModel: Record<string, jest.Mock>;
  let ticketPurchaseModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;

  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const ticketTypeId = new Types.ObjectId().toString();

  const mockEvent = (overrides = {}) => ({
    _id: eventId,
    organizer: { toString: () => organizerId },
    ...overrides,
  });

  const mockTicketType = (overrides = {}) => ({
    _id: ticketTypeId,
    name: 'VIP',
    price: 150,
    quantity: 100,
    event: { toString: () => eventId },
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    ticketTypeModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      create: jest.fn(),
    };

    ticketPurchaseModel = {
      find: jest.fn(),
    };

    eventModel = {
      findById: jest.fn(),
    };

    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
    ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
    ticketTypeModel.find.mockReturnValue(makeChainable([mockTicketType()]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: getModelToken(TicketType.name), useValue: ticketTypeModel },
        { provide: getModelToken(TicketPurchase.name), useValue: ticketPurchaseModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createTicketType ──
  describe('createTicketType', () => {
    it('crée un type de billet pour l\'événement', async () => {
      const dto = { name: 'VIP', price: 150, quantity: 100 };
      const tt = mockTicketType(dto);
      ticketTypeModel.create.mockResolvedValue(tt);

      const result = await service.createTicketType(eventId, organizerId, dto as never);

      expect(ticketTypeModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'VIP' }),
      );
      expect(result).toBeDefined();
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.createTicketType(eventId, 'autre-user-id', { name: 'VIP' } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'événement n\'existe pas', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(
        service.createTicketType('id-inexistant', organizerId, { name: 'VIP' } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── findTicketTypes ──
  describe('findTicketTypes', () => {
    it('retourne les types de billets pour l\'événement', async () => {
      const result = await service.findTicketTypes(eventId);

      expect(result).toHaveLength(1);
      expect(ticketTypeModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ event: expect.any(Types.ObjectId) }),
      );
    });
  });

  // ── updateTicketType ──
  describe('updateTicketType', () => {
    it('met à jour et retourne le type de billet', async () => {
      const dto = { name: 'VIP Platinum' };
      const updated = mockTicketType(dto);
      ticketTypeModel.findByIdAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.updateTicketType(ticketTypeId, organizerId, dto as never);

      expect(result.name).toBe('VIP Platinum');
    });

    it('lève NotFoundException si le type de billet n\'existe pas', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(null));

      await expect(
        service.updateTicketType('id-inexistant', organizerId, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.updateTicketType(ticketTypeId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── removeTicketType ──
  describe('removeTicketType', () => {
    it('supprime le type de billet', async () => {
      ticketTypeModel.findByIdAndDelete.mockResolvedValue({});

      await expect(service.removeTicketType(ticketTypeId, organizerId)).resolves.toBeUndefined();
      expect(ticketTypeModel.findByIdAndDelete).toHaveBeenCalledWith(ticketTypeId);
    });

    it('lève NotFoundException si le type de billet n\'existe pas', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.removeTicketType('id-inexistant', organizerId)).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(service.removeTicketType(ticketTypeId, 'autre-user-id')).rejects.toThrow(ForbiddenException);
    });
  });

  // ── findMyTickets ──
  describe('findMyTickets', () => {
    it('retourne les billets de l\'acheteur', async () => {
      const buyerId = new Types.ObjectId().toString();
      ticketPurchaseModel.find.mockReturnValue(makeChainable([{ _id: 'ticket-1' }]));

      const result = await service.findMyTickets(buyerId);

      expect(result).toHaveLength(1);
      expect(ticketPurchaseModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ buyerId: expect.any(Types.ObjectId) }),
      );
    });
  });
});
