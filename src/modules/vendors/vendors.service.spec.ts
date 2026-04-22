import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VendorsService } from './vendors.service';
import { VendorProfile, VendorCategory } from './vendor.schema';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('VendorsService', () => {
  let service: VendorsService;
  let vendorModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const vendorId = new Types.ObjectId().toString();

  const mockVendor = (overrides = {}) => ({
    _id: vendorId,
    businessName: 'Photo Pro',
    category: VendorCategory.PHOTOGRAPHE,
    user: { toString: () => userId },
    isActive: true,
    rating: 4.5,
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    vendorModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    vendorModel.find.mockReturnValue(makeChainable([mockVendor()]));
    vendorModel.findById.mockReturnValue(makeChainable(mockVendor()));
    vendorModel.findOne.mockReturnValue(makeChainable(null));
    vendorModel.countDocuments.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
      ],
    }).compile();

    service = module.get<VendorsService>(VendorsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ──
  describe('create', () => {
    it('crée un profil prestataire et le retourne', async () => {
      const dto = { businessName: 'Photo Pro', category: VendorCategory.PHOTOGRAPHE };
      vendorModel.create.mockResolvedValue(mockVendor(dto));

      const result = await service.create(userId, dto as never);

      expect(vendorModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessName: 'Photo Pro' }),
      );
      expect(result).toBeDefined();
    });

    it('lève ConflictException si un profil existe déjà pour ce compte', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable({ _id: vendorId }));

      await expect(
        service.create(userId, { businessName: 'Photo Pro' } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── findAll ──
  describe('findAll', () => {
    it('retourne une liste paginée de prestataires actifs', async () => {
      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(vendorModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
      );
    });

    it('filtre par catégorie si fournie', async () => {
      vendorModel.find.mockReturnValue(makeChainable([]));
      vendorModel.countDocuments.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20, category: VendorCategory.TRAITEUR });

      expect(vendorModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ category: VendorCategory.TRAITEUR }),
      );
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('retourne le profil prestataire correspondant à l\'ID', async () => {
      const result = await service.findOne(vendorId);

      expect((result as unknown as Record<string, unknown>)._id).toBe(vendorId);
    });

    it('lève NotFoundException si le prestataire n\'existe pas', async () => {
      vendorModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.findOne('id-inexistant')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findMyProfile ──
  describe('findMyProfile', () => {
    it('retourne le profil de l\'utilisateur connecté', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable(mockVendor()));

      const result = await service.findMyProfile(userId);

      expect(result).toBeDefined();
    });

    it('lève NotFoundException si aucun profil n\'existe pour cet utilisateur', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable(null));

      const otherUserId = new Types.ObjectId().toString();
      await expect(service.findMyProfile(otherUserId)).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ──
  describe('update', () => {
    it('met à jour et retourne le profil modifié', async () => {
      const dto = { businessName: 'Photo Pro Elite' };
      const updated = mockVendor(dto);
      vendorModel.findByIdAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.update(vendorId, userId, dto as never);

      expect(result.businessName).toBe('Photo Pro Elite');
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas le propriétaire', async () => {
      await expect(
        service.update(vendorId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si le prestataire n\'existe pas', async () => {
      vendorModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.update('id-inexistant', userId, {})).rejects.toThrow(NotFoundException);
    });
  });
});
