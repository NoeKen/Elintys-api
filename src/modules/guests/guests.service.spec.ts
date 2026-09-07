import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { GuestsService } from './guests.service';
import { Guest } from './guest.schema';
import { Event } from '../events/event.schema';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('GuestsService', () => {
  let service: GuestsService;
  let guestModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;

  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const guestId = new Types.ObjectId().toString();

  const mockEvent = (overrides = {}) => ({
    _id: eventId,
    organizer: { toString: () => organizerId },
    ...overrides,
  });

  const mockGuest = (overrides = {}) => ({
    _id: guestId,
    name: 'Marie Dupont',
    email: 'marie@test.com',
    status: 'invited',
    event: { toString: () => eventId },
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    guestModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    eventModel = {
      findById: jest.fn(),
    };

    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
    guestModel.find.mockReturnValue(makeChainable([mockGuest()]));
    guestModel.findByIdAndUpdate.mockReturnValue(makeChainable(mockGuest()));
    guestModel.findOneAndUpdate.mockReturnValue(makeChainable(mockGuest()));
    guestModel.countDocuments.mockResolvedValue(1);

    testingModule = await Test.createTestingModule({
      providers: [
        GuestsService,
        { provide: getModelToken(Guest.name), useValue: guestModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
      ],
    }).compile();

    service = testingModule.get<GuestsService>(GuestsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ──
  describe('create', () => {
    it('ajoute un invité à l\'événement', async () => {
      const dto = { name: 'Marie Dupont', email: 'marie@test.com' };
      guestModel.create.mockResolvedValue(mockGuest(dto));

      const result = await service.create(eventId, organizerId, dto as never);

      expect(guestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Marie Dupont' }),
      );
      expect(result).toBeDefined();
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.create(eventId, 'autre-user-id', { name: 'Marie' } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'événement n\'existe pas', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(
        service.create('id-inexistant', organizerId, { name: 'Marie' } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── findAll ──
  describe('findAll', () => {
    it('retourne les invités paginés de l\'événement', async () => {
      const result = await service.findAll(eventId, organizerId, 1, 50);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.findAll(eventId, 'autre-user-id', 1, 50),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── update ──
  describe('update', () => {
    it('met à jour le statut d\'un invité', async () => {
      const dto = { status: 'confirmed' };
      const updated = mockGuest(dto);
      guestModel.findOneAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.update(guestId, eventId, organizerId, dto as never);

      expect(result.status).toBe('confirmed');
      expect(guestModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: guestId, event: expect.any(Types.ObjectId) },
        dto,
        { new: true, runValidators: true },
      );
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.update(guestId, eventId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'invité n\'existe pas', async () => {
      guestModel.findOneAndUpdate.mockReturnValue(makeChainable(null));

      await expect(
        service.update('id-inexistant', eventId, organizerId, {}),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('supprime un invité de l\'événement', async () => {
      guestModel.findOneAndDelete.mockResolvedValue({ _id: guestId });

      await expect(service.remove(guestId, eventId, organizerId)).resolves.toBeUndefined();
      expect(guestModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: guestId,
        event: expect.any(Types.ObjectId),
      });
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas l\'organisateur', async () => {
      await expect(
        service.remove(guestId, eventId, 'autre-user-id'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si l\'invité n\'existe pas', async () => {
      guestModel.findOneAndDelete.mockResolvedValue(null);

      await expect(service.remove('id-inexistant', eventId, organizerId)).rejects.toThrow(NotFoundException);
    });
  });
});
