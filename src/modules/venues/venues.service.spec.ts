import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VenuesService } from './venues.service';
import { VenueBooking, VenueBookingSchema, VenueBookingStatus, VenueProfile } from './venue.schema';
import { NotificationsService } from '../notifications/notifications.service';

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
  let venueBookingModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const venueId = new Types.ObjectId().toString();
  const bookingId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();

  const mockVenue = (overrides = {}) => ({
    _id: new Types.ObjectId(venueId),
    name: 'Salle des Mille Étoiles',
    capacity: 500,
    isActive: true,
    user: { toString: () => userId },
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  const mockBooking = (overrides = {}) => ({
    _id: new Types.ObjectId(bookingId),
    event: new Types.ObjectId(eventId),
    venue: new Types.ObjectId(venueId),
    organizer: new Types.ObjectId(userId),
    status: VenueBookingStatus.PENDING,
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

    venueBookingModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      create: jest.fn(),
    };

    venueModel.find.mockReturnValue(makeChainable([mockVenue()]));
    venueModel.findById.mockReturnValue(makeChainable(mockVenue()));
    venueModel.findOne.mockReturnValue(makeChainable(null));
    venueModel.countDocuments.mockResolvedValue(1);

    venueBookingModel.find.mockReturnValue(makeChainable([mockBooking()]));
    venueBookingModel.findById.mockReturnValue(makeChainable(mockBooking()));
    venueBookingModel.findByIdAndUpdate.mockReturnValue(makeChainable(mockBooking()));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VenuesService,
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
        { provide: getModelToken(VenueBooking.name), useValue: venueBookingModel },
        { provide: NotificationsService, useValue: { create: jest.fn().mockResolvedValue(undefined) } },
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

      expect((result as unknown as Record<string, unknown>)._id).toBeDefined();
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

  // ── findMyProfile ──
  describe('findMyProfile', () => {
    it('devrait retourner le profil de salle de l\'utilisateur connecté', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(mockVenue()));

      const result = await service.findMyProfile(userId);

      expect(venueModel.findOne).toHaveBeenCalledWith({ user: expect.any(Types.ObjectId) });
      expect(result).toBeDefined();
    });

    it('devrait lever NotFoundException si profil introuvable', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(null));

      await expect(service.findMyProfile(userId)).rejects.toThrow(NotFoundException);
    });
  });

  // ── requestBooking ──
  describe('requestBooking', () => {
    const dto = {
      venueId,
      bookingStart: '2025-12-01T18:00:00Z',
      bookingEnd: '2025-12-02T02:00:00Z',
    };

    it('devrait créer une réservation avec les bonnes dates', async () => {
      venueBookingModel.create.mockResolvedValue(mockBooking());

      const result = await service.requestBooking(eventId, userId, dto as never);

      expect(venueBookingModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: VenueBookingStatus.PENDING }),
      );
      expect(result).toBeDefined();
    });

    it('devrait lever BadRequestException si bookingEnd <= bookingStart', async () => {
      const badDto = {
        venueId,
        bookingStart: '2025-12-02T02:00:00Z',
        bookingEnd: '2025-12-01T18:00:00Z',
      };

      await expect(service.requestBooking(eventId, userId, badDto as never)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── listBookingsByEvent ──
  describe('listBookingsByEvent', () => {
    it('devrait retourner les réservations d\'un événement', async () => {
      venueBookingModel.find.mockReturnValue(makeChainable([mockBooking()]));

      const result = await service.listBookingsByEvent(eventId);

      expect(venueBookingModel.find).toHaveBeenCalledWith({ event: expect.any(Types.ObjectId) });
      expect(result).toHaveLength(1);
    });
  });

  // ── respondToBooking ──
  describe('respondToBooking', () => {
    it('devrait confirmer une réservation en attente', async () => {
      const venueProfileId = new Types.ObjectId(venueId);
      venueBookingModel.findById.mockReturnValue(
        makeChainable({ status: VenueBookingStatus.PENDING, venue: venueProfileId, organizer: new Types.ObjectId(userId) }),
      );
      venueModel.findOne.mockReturnValue(makeChainable({ _id: venueProfileId }));
      const confirmed = mockBooking({ status: VenueBookingStatus.CONFIRMED });
      venueBookingModel.findByIdAndUpdate.mockReturnValue(makeChainable(confirmed));

      const result = await service.respondToBooking(bookingId, userId, {
        status: VenueBookingStatus.CONFIRMED,
      });

      expect(result).toBeDefined();
    });

    it('devrait lever BadRequestException si la réservation n\'est pas en attente', async () => {
      venueBookingModel.findById.mockReturnValue(
        makeChainable({ status: VenueBookingStatus.CONFIRMED, venue: new Types.ObjectId(venueId) }),
      );

      await expect(
        service.respondToBooking(bookingId, userId, { status: VenueBookingStatus.CONFIRMED }),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait lever ForbiddenException si le gestionnaire ne correspond pas', async () => {
      const otherVenueId = new Types.ObjectId();
      venueBookingModel.findById.mockReturnValue(
        makeChainable({ status: VenueBookingStatus.PENDING, venue: new Types.ObjectId(venueId) }),
      );
      venueModel.findOne.mockReturnValue(makeChainable({ _id: otherVenueId }));

      await expect(
        service.respondToBooking(bookingId, userId, { status: VenueBookingStatus.CONFIRMED }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── listMyBookings ──
  describe('listMyBookings', () => {
    it('devrait retourner les réservations reçues par la salle', async () => {
      venueModel.findOne.mockReturnValue(makeChainable({ _id: new Types.ObjectId(venueId) }));
      venueBookingModel.find.mockReturnValue(makeChainable([mockBooking()]));

      const result = await service.listMyBookings(userId);

      expect(result).toHaveLength(1);
    });

    it('devrait lever NotFoundException si profil de salle introuvable', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(null));

      await expect(service.listMyBookings(userId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('VenueBooking schema — source et externalContact (CDC v3)', () => {
    it('devrait avoir source à platform par défaut', () => {
      const path = VenueBookingSchema.path('source');
      expect(path).toBeDefined();
      expect((path as unknown as { defaultValue: string }).defaultValue).toBe('platform');
    });

    it('devrait avoir externalContact défini dans le schéma', () => {
      const path = VenueBookingSchema.path('externalContact');
      expect(path).toBeDefined();
    });
  });
});
