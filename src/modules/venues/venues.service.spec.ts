import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { VenuesService } from './venues.service';
import { VenueBooking, VenueBookingSchema, VenueBookingStatus, VenueProfile, VenueType } from './venue.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailsService } from '../emails/emails.service';
import { User } from '../auth/user.schema';
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

describe('VenuesService', () => {
  let service: VenuesService;
  let venueModel: Record<string, jest.Mock>;
  let venueBookingModel: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;

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
      findOneAndUpdate: jest.fn(),
    };

    venueBookingModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    eventModel = {
      findById: jest.fn().mockReturnValue(makeChainable({ title: 'Test Event', organizer: { toString: () => userId } })),
    };

    venueModel.find.mockReturnValue(makeChainable([mockVenue()]));
    venueModel.findById.mockReturnValue(makeChainable(mockVenue()));
    venueModel.findOne.mockReturnValue(makeChainable(null));
    venueModel.countDocuments.mockResolvedValue(1);

    venueBookingModel.find.mockReturnValue(makeChainable([mockBooking()]));
    venueBookingModel.findById.mockReturnValue(makeChainable(mockBooking()));
    venueBookingModel.findByIdAndUpdate.mockReturnValue(makeChainable(mockBooking()));

    notificationsService = { create: jest.fn().mockResolvedValue(undefined) };

    testingModule = await Test.createTestingModule({
      providers: [
        VenuesService,
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
        { provide: getModelToken(VenueBooking.name), useValue: venueBookingModel },
        { provide: getModelToken(User.name), useValue: { findById: jest.fn().mockReturnValue(makeChainable({ email: 'org@test.com', fullName: 'Org' })) } },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: EmailsService, useValue: { sendVenueBookingUpdate: jest.fn().mockResolvedValue(undefined) } },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') } },
      ],
    }).compile();

    service = testingModule.get<VenuesService>(VenuesService);
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
      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(venueModel.find).toHaveBeenCalledWith({ isActive: true });
    });

    it('filtre par type, ville et capacité minimale', async () => {
      await service.findAll({
        type: VenueType.ROOFTOP,
        city: 'Montréal',
        capacity: 200,
      });

      expect(venueModel.find).toHaveBeenCalledWith({
        isActive: true,
        type: VenueType.ROOFTOP,
        'address.city': { $regex: 'Montréal', $options: 'i' },
        capacity: { $gte: 200 },
      });
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('retourne la salle correspondant à l\'ID', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(mockVenue()));

      const result = await service.findOne(venueId);

      expect((result as unknown as Record<string, unknown>)._id).toBeDefined();
    });

    it('lève NotFoundException si la salle n\'existe pas', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(null));

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
      venueModel.findOne.mockReturnValue(makeChainable(mockVenue()));

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

    it('refuse une réservation sur l’événement d’un tiers', async () => {
      eventModel.findById.mockReturnValue(makeChainable({ organizer: { toString: () => 'other-user' } }));
      venueModel.findOne.mockReturnValue(makeChainable(mockVenue()));
      await expect(service.requestBooking(eventId, userId, dto as never)).rejects.toThrow(ForbiddenException);
      expect(venueBookingModel.create).not.toHaveBeenCalled();
    });

    it('refuse une salle inexistante ou inactive', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(null));
      await expect(service.requestBooking(eventId, userId, dto as never)).rejects.toThrow(NotFoundException);
      expect(venueBookingModel.create).not.toHaveBeenCalled();
    });
  });

  // ── updateMyProfile (F-04) ──
  describe('updateMyProfile', () => {
    it('cible la fiche du user connecté, jamais un id fourni par le client', async () => {
      venueModel.findOneAndUpdate.mockReturnValue(makeChainable(mockVenue()));

      await service.updateMyProfile(userId, { name: 'Nouvelle salle' });

      const [filter] = venueModel.findOneAndUpdate.mock.calls[0] as [{ user: Types.ObjectId }];
      expect(filter.user.toString()).toBe(userId);
    });

    it('lève NotFoundException si aucune fiche n’existe encore', async () => {
      venueModel.findOneAndUpdate.mockReturnValue(makeChainable(null));

      await expect(service.updateMyProfile(userId, { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancelBooking', () => {
    it('annule via une transition conditionnelle sur l’état observé', async () => {
      venueBookingModel.findById.mockReturnValue(
        makeChainable({
          event: new Types.ObjectId(eventId),
          status: VenueBookingStatus.PENDING,
        }),
      );
      venueBookingModel.findOneAndUpdate.mockReturnValue(
        makeChainable(mockBooking({ status: VenueBookingStatus.CANCELLED })),
      );

      const result = await service.cancelBooking(bookingId, userId);

      expect(result.status).toBe(VenueBookingStatus.CANCELLED);
      const [filter] = venueBookingModel.findOneAndUpdate.mock.calls[0] as [
        { status: string },
      ];
      expect(filter.status).toBe(VenueBookingStatus.PENDING);
    });

    it('n’écrase pas une confirmation concurrente postérieure au début de l’annulation', async () => {
      const respondedAt = new Date(Date.now() + 1_000);
      venueBookingModel.findById.mockReturnValue(
        makeChainable({
          event: new Types.ObjectId(eventId),
          status: VenueBookingStatus.CONFIRMED,
          respondedAt,
        }),
      );
      venueBookingModel.findOneAndUpdate.mockReturnValue(makeChainable(null));

      await expect(service.cancelBooking(bookingId, userId)).rejects.toThrow(ConflictException);

      const [filter] = venueBookingModel.findOneAndUpdate.mock.calls[0] as [
        { status: string; $or: Array<Record<string, unknown>> },
      ];
      expect(filter.status).toBe(VenueBookingStatus.CONFIRMED);
      expect(filter.$or).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ respondedAt: expect.objectContaining({ $lt: expect.any(Date) }) }),
        ]),
      );
    });

    it('refuse l’annulation d’une réservation liée à l’événement d’un tiers', async () => {
      venueBookingModel.findById.mockReturnValue(
        makeChainable({ event: new Types.ObjectId(eventId), status: VenueBookingStatus.PENDING }),
      );

      await expect(service.cancelBooking(bookingId, new Types.ObjectId().toString()))
        .rejects.toThrow(ForbiddenException);
      expect(venueBookingModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('lève ConflictException si la réservation a changé d’état entre-temps', async () => {
      venueBookingModel.findById.mockReturnValue(
        makeChainable({ event: new Types.ObjectId(eventId), status: VenueBookingStatus.PENDING }),
      );
      venueBookingModel.findOneAndUpdate.mockReturnValue(makeChainable(null));

      await expect(service.cancelBooking(bookingId, userId)).rejects.toThrow(ConflictException);
    });
  });

  // ── listBookingsByEvent ──
  describe('listBookingsByEvent', () => {
    it('devrait retourner les réservations d\'un événement', async () => {
      venueBookingModel.find.mockReturnValue(makeChainable([mockBooking()]));

      const result = await service.listBookingsByEvent(eventId, userId);

      expect(venueBookingModel.find).toHaveBeenCalledWith({ event: expect.any(Types.ObjectId) });
      expect(result).toHaveLength(1);
    });

    it('refuse la lecture des réservations d’un événement tiers', async () => {
      eventModel.findById.mockReturnValue(makeChainable({ organizer: { toString: () => 'other-user' } }));
      await expect(service.listBookingsByEvent(eventId, userId)).rejects.toThrow(ForbiddenException);
    });
  });

  // ── respondToBooking ──
  describe('respondToBooking', () => {
    const confirmDto = { status: VenueBookingStatus.CONFIRMED as VenueBookingStatus.CONFIRMED };
    const myProfile = () =>
      makeChainable({ _id: new Types.ObjectId(venueId), name: 'Salle Saint-Paul' });

    it('confirme une réservation en attente via une transition conditionnelle', async () => {
      venueModel.findOne.mockReturnValue(myProfile());
      venueBookingModel.findOneAndUpdate.mockReturnValue(
        makeChainable(mockBooking({ status: VenueBookingStatus.CONFIRMED })),
      );

      const result = await service.respondToBooking(bookingId, userId, confirmDto);

      const [filter] = venueBookingModel.findOneAndUpdate.mock.calls[0] as [
        { status: string; venue: Types.ObjectId },
      ];
      expect(filter.status).toBe(VenueBookingStatus.PENDING);
      expect(filter.venue.toString()).toBe(venueId);
      expect(result).toBeDefined();
    });

    it('enregistre responseMessage et respondedAt', async () => {
      venueModel.findOne.mockReturnValue(myProfile());
      venueBookingModel.findOneAndUpdate.mockReturnValue(makeChainable(mockBooking()));

      await service.respondToBooking(bookingId, userId, {
        ...confirmDto,
        responseMessage: 'Salle disponible',
      });

      const [, update] = venueBookingModel.findOneAndUpdate.mock.calls[0] as [
        unknown,
        { responseMessage?: string; respondedAt?: Date },
      ];
      expect(update.responseMessage).toBe('Salle disponible');
      expect(update.respondedAt).toBeInstanceOf(Date);
    });

    it("lève NotFoundException si le gestionnaire n'a pas de fiche", async () => {
      venueModel.findOne.mockReturnValue(makeChainable(null));

      await expect(service.respondToBooking(bookingId, userId, confirmDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lève ForbiddenException si la réservation vise une autre salle', async () => {
      venueModel.findOne.mockReturnValue(myProfile());
      venueBookingModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      venueBookingModel.findById.mockReturnValue(
        makeChainable({ venue: new Types.ObjectId(), status: VenueBookingStatus.PENDING }),
      );

      await expect(service.respondToBooking(bookingId, userId, confirmDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("lève ConflictException si la réservation n'est plus en attente", async () => {
      venueModel.findOne.mockReturnValue(myProfile());
      venueBookingModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      venueBookingModel.findById.mockReturnValue(
        makeChainable({
          venue: new Types.ObjectId(venueId),
          status: VenueBookingStatus.CONFIRMED,
        }),
      );

      await expect(service.respondToBooking(bookingId, userId, confirmDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it("n'émet AUCUN effet de bord lorsque la transition est perdue", async () => {
      venueModel.findOne.mockReturnValue(myProfile());
      venueBookingModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      venueBookingModel.findById.mockReturnValue(
        makeChainable({
          venue: new Types.ObjectId(venueId),
          status: VenueBookingStatus.CONFIRMED,
        }),
      );

      await expect(service.respondToBooking(bookingId, userId, confirmDto)).rejects.toThrow(
        ConflictException,
      );
      expect(notificationsService.create).not.toHaveBeenCalled();
    });

    it('un seul de deux réponses concurrentes gagne', async () => {
      venueModel.findOne.mockReturnValue(myProfile());
      venueBookingModel.findOneAndUpdate
        .mockReturnValueOnce(makeChainable(mockBooking({ status: VenueBookingStatus.CONFIRMED })))
        .mockReturnValue(makeChainable(null));
      venueBookingModel.findById.mockReturnValue(
        makeChainable({
          venue: new Types.ObjectId(venueId),
          status: VenueBookingStatus.CONFIRMED,
        }),
      );

      const outcomes = await Promise.allSettled([
        service.respondToBooking(bookingId, userId, confirmDto),
        service.respondToBooking(bookingId, userId, {
          status: VenueBookingStatus.REFUSED as VenueBookingStatus.REFUSED,
        }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(notificationsService.create).toHaveBeenCalledTimes(1);
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

  describe('projection publique', () => {
    it("n'expose ni compte propriétaire ni téléphone privé dans le catalogue", async () => {
      venueModel.find.mockReturnValue(makeChainable([mockVenue()]));

      await service.findAll({} as never);

      const projection = venueModel.find.mock.results[0].value.select.mock.calls[0][0] as string;
      expect(projection).not.toContain('user');
      expect(projection).not.toContain('contactPhone');
      expect(projection).toContain('name');
    });

    it('ne sert une fiche publique que si la salle est active', async () => {
      venueModel.findOne.mockReturnValue(makeChainable(mockVenue()));

      await service.findOne(venueId);

      expect(venueModel.findOne).toHaveBeenCalledWith({ _id: venueId, isActive: true });
      const projection = venueModel.findOne.mock.results[0].value.select.mock.calls[0][0] as string;
      expect(projection).not.toContain('user');
      expect(projection).not.toContain('contactPhone');
    });
  });
});
