import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VenuesService } from './venues.service';
import { VenueProfile } from './venue.schema';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('VenuesService', () => {
  let service: VenuesService;
  let venueModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const venueId = new Types.ObjectId().toString();

  const mockVenue = (overrides = {}) => ({
    _id: venueId,
    name: 'Salle des Mille Étoiles',
    capacity: 500,
    isActive: true,
    user: { toString: () => userId },
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    venueModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    venueModel.find.mockReturnValue(makeChainable([mockVenue()]));
    venueModel.findById.mockReturnValue(makeChainable(mockVenue()));
    venueModel.findOne.mockReturnValue(makeChainable(null));
    venueModel.countDocuments.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VenuesService,
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
      ],
    }).compile();

    service = module.get<VenuesService>(VenuesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ──
  describe('create', () => {
    it('crée un profil de salle et le retourne', async () => {
      const dto = {
        name: 'Salle des Mille Étoiles',
        capacity: 500,
        address: { street: '123 rue Main', city: 'Montréal', province: 'QC' },
      };
      venueModel.create.mockResolvedValue(mockVenue(dto));

      const result = await service.create(userId, dto as never);

      expect(venueModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: dto.name }),
      );
      expect(result).toBeDefined();
    });

    it('lève ConflictException si un profil existe déjà pour ce compte', async () => {
      venueModel.findOne.mockReturnValue(makeChainable({ _id: venueId }));

      await expect(
        service.create(userId, { name: 'Salle', capacity: 100 } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── findAll ──
  describe('findAll', () => {
    it('retourne une liste paginée de salles actives', async () => {
      const result = await service.findAll(1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(venueModel.find).toHaveBeenCalledWith({ isActive: true });
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('retourne la salle correspondant à l\'ID', async () => {
      const result = await service.findOne(venueId);

      expect((result as unknown as Record<string, unknown>)._id).toBe(venueId);
    });

    it('lève NotFoundException si la salle n\'existe pas', async () => {
      venueModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.findOne('id-inexistant')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ──
  describe('update', () => {
    it('met à jour et retourne la salle modifiée', async () => {
      const dto = { name: 'Grande Salle' };
      const updated = mockVenue(dto);
      venueModel.findByIdAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.update(venueId, userId, dto as never);

      expect(result.name).toBe('Grande Salle');
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas le propriétaire', async () => {
      await expect(
        service.update(venueId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si la salle n\'existe pas', async () => {
      venueModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.update('id-inexistant', userId, {})).rejects.toThrow(NotFoundException);
    });
  });
});
