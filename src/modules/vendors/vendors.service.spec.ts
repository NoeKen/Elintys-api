import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VendorsService } from './vendors.service';
import { VendorProfile, VendorCategory, VendorRequest, VendorRequestSchema, VendorRequestStatus, VendorRequestSource } from './vendor.schema';

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
  let vendorRequestModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const vendorId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const requestId = new Types.ObjectId().toString();

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

  const mockRequest = (overrides = {}) => ({
    _id: requestId,
    event: new Types.ObjectId(eventId),
    organizer: { toString: () => userId },
    vendor: new Types.ObjectId(vendorId),
    status: VendorRequestStatus.PENDING,
    source: VendorRequestSource.PLATFORM,
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

    vendorRequestModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      create: jest.fn(),
    };

    vendorModel.find.mockReturnValue(makeChainable([mockVendor()]));
    vendorModel.findById.mockReturnValue(makeChainable(mockVendor()));
    vendorModel.findOne.mockReturnValue(makeChainable(null));
    vendorModel.countDocuments.mockResolvedValue(1);

    vendorRequestModel.find.mockReturnValue(makeChainable([mockRequest()]));
    vendorRequestModel.findById.mockReturnValue(makeChainable(mockRequest()));
    vendorRequestModel.findByIdAndUpdate.mockReturnValue(makeChainable(mockRequest()));
    vendorRequestModel.findByIdAndDelete.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
        { provide: getModelToken(VendorRequest.name), useValue: vendorRequestModel },
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

  // ── createRequest ──
  describe('createRequest', () => {
    it('devrait créer une demande plateforme avec un vendorId', async () => {
      const dto = { vendorId, source: VendorRequestSource.PLATFORM, message: 'Bonjour' };
      vendorRequestModel.create.mockResolvedValue(mockRequest());

      const result = await service.createRequest(eventId, userId, dto);

      expect(vendorRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ source: VendorRequestSource.PLATFORM, status: VendorRequestStatus.PENDING }),
      );
      expect(result).toBeDefined();
    });

    it('devrait créer une demande manuelle sans vendorId (source=manual)', async () => {
      const externalContact = { name: 'Jean Photo', email: 'jean@example.com' };
      const dto = { source: VendorRequestSource.MANUAL, externalContact };
      vendorRequestModel.create.mockResolvedValue(mockRequest({ vendor: undefined, source: VendorRequestSource.MANUAL }));

      const result = await service.createRequest(eventId, userId, dto);

      expect(vendorRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ source: VendorRequestSource.MANUAL }),
      );
      expect(result).toBeDefined();
    });
  });

  // ── listRequestsByEvent ──
  describe('listRequestsByEvent', () => {
    it('devrait retourner les demandes pour un événement', async () => {
      const result = await service.listRequestsByEvent(eventId);

      expect(vendorRequestModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ event: expect.any(Types.ObjectId) }),
      );
      expect(result).toHaveLength(1);
    });
  });

  // ── listMyRequests ──
  describe('listMyRequests', () => {
    it('devrait retourner les demandes du prestataire connecté', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable({ _id: new Types.ObjectId(vendorId) }));

      const result = await service.listMyRequests(userId);

      expect(vendorRequestModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ vendor: expect.any(Types.ObjectId) }),
      );
      expect(result).toHaveLength(1);
    });

    it('devrait lever NotFoundException si le profil prestataire est introuvable', async () => {
      jest.spyOn(vendorModel, 'findOne').mockReturnValue({
        lean: () => ({ select: () => null }),
      } as any);

      await expect(service.listMyRequests(userId)).rejects.toThrow(NotFoundException);
    });
  });

  // ── respondToRequest ──
  describe('respondToRequest', () => {
    it('devrait accepter une demande en attente', async () => {
      const request = mockRequest({ vendor: new Types.ObjectId(vendorId) });
      vendorRequestModel.findById.mockReturnValue(makeChainable(request));
      vendorModel.findOne.mockReturnValue(makeChainable({ _id: new Types.ObjectId(vendorId) }));
      const acceptedRequest = mockRequest({ status: VendorRequestStatus.ACCEPTED });
      vendorRequestModel.findByIdAndUpdate.mockReturnValue(makeChainable(acceptedRequest));

      const dto = { status: VendorRequestStatus.ACCEPTED as VendorRequestStatus.ACCEPTED };
      const result = await service.respondToRequest(requestId, userId, dto);

      expect(vendorRequestModel.findByIdAndUpdate).toHaveBeenCalledWith(
        requestId,
        expect.objectContaining({ status: VendorRequestStatus.ACCEPTED }),
        { new: true },
      );
      expect(result).toBeDefined();
    });

    it('devrait lever ForbiddenException si le prestataire ne correspond pas', async () => {
      const otherVendorId = new Types.ObjectId().toString();
      const request = mockRequest({ vendor: new Types.ObjectId(otherVendorId) });
      vendorRequestModel.findById.mockReturnValue(makeChainable(request));
      vendorModel.findOne.mockReturnValue(makeChainable({ _id: new Types.ObjectId(vendorId) }));

      const dto = { status: VendorRequestStatus.ACCEPTED as VendorRequestStatus.ACCEPTED };
      await expect(service.respondToRequest(requestId, userId, dto)).rejects.toThrow(ForbiddenException);
    });

    it('devrait lever BadRequestException si la demande n\'est pas en attente', async () => {
      // State check happens BEFORE ownership check — no need to mock vendorModel.findOne
      const request = mockRequest({ status: VendorRequestStatus.ACCEPTED, vendor: new Types.ObjectId(vendorId) });
      vendorRequestModel.findById.mockReturnValue(makeChainable(request));

      const dto = { status: VendorRequestStatus.DECLINED as VendorRequestStatus.DECLINED };
      await expect(service.respondToRequest(requestId, userId, dto)).rejects.toThrow(BadRequestException);
    });
  });

  // ── cancelRequest ──
  describe('cancelRequest', () => {
    it('devrait annuler une demande en attente', async () => {
      const request = mockRequest({ organizer: { toString: () => userId } });
      vendorRequestModel.findById.mockReturnValue(makeChainable(request));

      await service.cancelRequest(requestId, userId);

      expect(vendorRequestModel.findByIdAndDelete).toHaveBeenCalledWith(requestId);
    });

    it('devrait lever ForbiddenException si l\'organisateur ne correspond pas', async () => {
      const otherUserId = new Types.ObjectId().toString();
      const request = mockRequest({ organizer: { toString: () => otherUserId } });
      vendorRequestModel.findById.mockReturnValue(makeChainable(request));

      await expect(service.cancelRequest(requestId, userId)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('VendorRequest schema — source et externalContact (CDC v3)', () => {
    it('devrait avoir source à platform par défaut', () => {
      const path = VendorRequestSchema.path('source');
      expect(path).toBeDefined();
      expect((path as unknown as { defaultValue: string }).defaultValue).toBe('platform');
    });

    it('devrait avoir externalContact défini dans le schéma', () => {
      const path = VendorRequestSchema.path('externalContact');
      expect(path).toBeDefined();
    });
  });
});
