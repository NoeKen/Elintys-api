import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { EventsService } from './events.service';
import { Event, EventStatus } from './event.schema';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('EventsService', () => {
  let service: EventsService;
  let eventModel: Record<string, jest.Mock>;

  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();

  const mockEvent = (overrides = {}) => ({
    _id: eventId,
    title: 'Gala de printemps',
    status: EventStatus.DRAFT,
    visibility: 'public',
    organizer: { toString: () => organizerId },
    startDate: new Date('2025-06-15'),
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    eventModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    eventModel.find.mockReturnValue(makeChainable([mockEvent()]));
    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
    eventModel.countDocuments.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getModelToken(Event.name), useValue: eventModel },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ──
  describe('create', () => {
    it('crée un événement et retourne son objet', async () => {
      const dto = { title: 'Nouveau gala', startDate: new Date('2025-09-01') };
      const created = mockEvent({ ...dto, organizer: { toString: () => organizerId } });
      eventModel.create.mockResolvedValue(created);

      const result = await service.create(organizerId, dto as never);

      expect(eventModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: dto.title }),
      );
      expect(result).toBeDefined();
    });
  });

  // ── findAll ──
  describe('findAll', () => {
    it('retourne une liste paginée d\'événements', async () => {
      const result = await service.findAll({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });

    it('filtre par statut si fourni', async () => {
      eventModel.find.mockReturnValue(makeChainable([]));
      eventModel.countDocuments.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, status: EventStatus.PUBLISHED });

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: EventStatus.PUBLISHED }),
      );
    });

    it('filtre par ville si fourni', async () => {
      eventModel.find.mockReturnValue(makeChainable([]));
      eventModel.countDocuments.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, city: 'Montréal' });

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ 'location.city': expect.any(Object) }),
      );
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('retourne l\'événement correspondant à l\'ID', async () => {
      const result = await service.findOne(eventId);

      expect((result as unknown as Record<string, unknown>)._id).toBe(eventId);
    });

    it('lève NotFoundException si l\'événement n\'existe pas', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.findOne('id-inexistant')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ──
  describe('update', () => {
    it('met à jour et retourne l\'événement modifié', async () => {
      const dto = { title: 'Titre modifié' };
      const updated = mockEvent({ title: dto.title });
      eventModel.findByIdAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.update(eventId, organizerId, dto as never);

      expect(result.title).toBe('Titre modifié');
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.update(eventId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'événement n\'existe pas', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.update('id-inexistant', organizerId, {})).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('supprime l\'événement si l\'utilisateur est l\'organisateur', async () => {
      eventModel.findByIdAndDelete.mockResolvedValue({});

      await expect(service.remove(eventId, organizerId)).resolves.toBeUndefined();
      expect(eventModel.findByIdAndDelete).toHaveBeenCalledWith(eventId);
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(service.remove(eventId, 'autre-user-id')).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'événement n\'existe pas', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.remove('id-inexistant', organizerId)).rejects.toThrow(NotFoundException);
    });
  });

  // ── publish ──
  describe('publish', () => {
    it('passe le statut de l\'événement à "published"', async () => {
      const published = mockEvent({ status: EventStatus.PUBLISHED });
      eventModel.findByIdAndUpdate.mockReturnValue(makeChainable(published));

      const result = await service.publish(eventId, organizerId);

      expect(result.status).toBe(EventStatus.PUBLISHED);
    });
  });

  // ── cancel ──
  describe('cancel', () => {
    it('passe le statut de l\'événement à "cancelled"', async () => {
      const cancelled = mockEvent({ status: EventStatus.CANCELLED });
      eventModel.findByIdAndUpdate.mockReturnValue(makeChainable(cancelled));

      const result = await service.cancel(eventId, organizerId);

      expect(result.status).toBe(EventStatus.CANCELLED);
    });
  });
});
