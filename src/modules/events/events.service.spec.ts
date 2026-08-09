import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { EventsService } from './events.service';
import {
  Event,
  EventAccessPolicyType,
  EventDiscoverability,
  EventStatus,
  EventType,
} from './event.schema';
import { EventMediaService } from './event-media.service';
import { EventAccessService } from './event-access.service';
import { TicketType } from '../tickets/ticket.schema';
import { EventAccessRequest } from './event-access-request.schema';
import {
  OrganizerEventDate,
  OrganizerEventProgress,
  OrganizerEventSort,
  OrganizerEventView,
} from './dto/query-event.dto';

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

describe('EventsService', () => {
  let service: EventsService;
  let eventModel: Record<string, jest.Mock>;
  const eventMediaService = {
    cleanupAfterEventDeletion: jest.fn().mockResolvedValue(undefined),
  };
  const eventAccessService = {
    preparePolicy: jest.fn(),
    toSafeEvent: jest.fn((event: unknown) => event),
    toPublicEvent: jest.fn((event: unknown) => event),
  };
  const ticketTypeModel = {
    countDocuments: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue([]),
  };
  const accessRequestModel = { aggregate: jest.fn().mockResolvedValue([]) };

  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();

  const mockEvent = (overrides = {}) => ({
    _id: eventId,
    title: 'Gala de printemps',
    status: EventStatus.DRAFT,
    visibility: 'public',
    discoverability: 'public',
    accessPolicy: { type: 'open' },
    admissionModes: ['registration_only'],
    eventType: EventType.GALA,
    location: { type: 'physical', name: 'Maison Elintys' },
    organizer: { toString: () => organizerId },
    startDate: new Date('2025-06-15'),
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    eventModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
    };

    eventModel.find.mockReturnValue(makeChainable([mockEvent()]));
    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
    eventModel.findByIdAndUpdate.mockReturnValue(makeChainable(mockEvent()));
    eventModel.findOne.mockReturnValue(makeChainable(null));
    eventModel.countDocuments.mockResolvedValue(1);
    eventModel.aggregate.mockResolvedValue([]);

    testingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(TicketType.name), useValue: ticketTypeModel },
        { provide: getModelToken(EventAccessRequest.name), useValue: accessRequestModel },
        { provide: EventMediaService, useValue: eventMediaService },
        { provide: EventAccessService, useValue: eventAccessService },
      ],
    }).compile();

    service = testingModule.get<EventsService>(EventsService);
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

    it('force uniquement les événements publics publiés', async () => {
      eventModel.find.mockReturnValue(makeChainable([]));
      eventModel.countDocuments.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 10, status: EventStatus.PUBLISHED });

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EventStatus.PUBLISHED,
          $or: expect.any(Array),
        }),
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

    it('filtre par catégorie publique si fournie', async () => {
      await service.findAll({
        page: 1,
        limit: 10,
        category: EventType.CONFERENCE,
      });

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: EventType.CONFERENCE }),
      );
    });
  });

  describe('getPublicCategoryCounts', () => {
    it('agrège uniquement les événements publics publiés', async () => {
      eventModel.aggregate.mockResolvedValue([
        { _id: EventType.CONFERENCE, count: 3 },
      ]);
      eventModel.countDocuments.mockResolvedValue(3);

      await expect(service.getPublicCategoryCounts()).resolves.toEqual({
        data: [{ category: EventType.CONFERENCE, count: 3 }],
        total: 3,
      });
      expect(eventModel.aggregate).toHaveBeenCalledWith(
        expect.arrayContaining([
          {
            $match: expect.objectContaining({
              status: EventStatus.PUBLISHED,
              $or: expect.any(Array),
            }),
          },
        ]),
      );
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('retourne l\'événement correspondant à l\'ID', async () => {
      const result = await service.findOne(eventId, organizerId);

      expect((result as unknown as Record<string, unknown>)._id).toBe(eventId);
    });

    it('lève NotFoundException si l\'événement n\'existe pas', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.findOne('id-inexistant', organizerId)).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException si le brouillon appartient à un autre organisateur', async () => {
      await expect(service.findOne(eventId, 'autre-user-id')).rejects.toThrow(ForbiddenException);
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
      expect(eventMediaService.cleanupAfterEventDeletion).toHaveBeenCalledWith(
        eventId,
        expect.objectContaining({ organizer: expect.anything() }),
      );
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

    it('retourne la readiness au propriétaire et protège les autres utilisateurs', async () => {
      ticketTypeModel.countDocuments
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(service.getPublishReadiness(eventId, organizerId)).resolves.toEqual(
        expect.objectContaining({ publishable: true }),
      );
      await expect(service.getPublishReadiness(eventId, 'autre-user-id')).rejects.toThrow(ForbiddenException);
      eventModel.findById.mockReturnValue(makeChainable(null));
      await expect(service.getPublishReadiness('id-inexistant', organizerId)).rejects.toThrow(NotFoundException);
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

  // ── create — génération slug ──
  describe('create — génération slug', () => {
    it('devrait générer un slug depuis le titre', async () => {
      // Arrange
      const dto = { title: 'Gala de charité', startDate: new Date('2025-09-01') };
      const created = mockEvent({ ...dto, slug: 'gala-de-charite', toObject: jest.fn().mockReturnThis() });
      eventModel.findOne = jest.fn().mockReturnValue(makeChainable(null));
      eventModel.create.mockResolvedValue(created);

      // Act
      await service.create(organizerId, dto as never);

      // Assert
      expect(eventModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ slug: expect.stringMatching(/^gala-de-charit/) }),
      );
    });

    it('devrait générer un slug unique si collision (ajouter -2)', async () => {
      // Arrange
      const dto = { title: 'Gala de charité', startDate: new Date('2025-09-01') };
      const existingDoc = { _id: new Types.ObjectId() };
      const created = mockEvent({ ...dto, slug: 'gala-de-charite-2', toObject: jest.fn().mockReturnThis() });
      eventModel.findOne = jest.fn()
        .mockReturnValueOnce(makeChainable(existingDoc))
        .mockReturnValueOnce(makeChainable(null));
      eventModel.create.mockResolvedValue(created);

      // Act
      await service.create(organizerId, dto as never);

      // Assert
      expect(eventModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ slug: expect.stringMatching(/-2$/) }),
      );
    });
  });

  // ── findBySlug ──
  describe('findBySlug', () => {
    it('devrait retourner un événement par slug', async () => {
      // Arrange
      const slug = 'gala-de-printemps';
      const event = mockEvent({ slug });
      eventModel.findOne = jest.fn().mockReturnValue(makeChainable(event));

      // Act
      const result = await service.findBySlug(slug);

      // Assert
      expect(eventModel.findOne).toHaveBeenCalledWith(expect.objectContaining({
        slug,
        status: EventStatus.PUBLISHED,
        $or: expect.any(Array),
      }));
      expect((result as unknown as Record<string, unknown>).slug).toBe(slug);
    });

    it('devrait lever NotFoundException si slug inexistant', async () => {
      // Arrange
      eventModel.findOne = jest.fn().mockReturnValue(makeChainable(null));

      // Act & Assert
      await expect(service.findBySlug('slug-inexistant')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findByOrganizer ──
  describe('findByOrganizer', () => {
    it('devrait retourner les événements paginés de l\'organisateur', async () => {
      // Arrange
      const events = [mockEvent(), mockEvent({ _id: new Types.ObjectId().toString() })];
      eventModel.find.mockReturnValue(makeChainable(events));
      eventModel.countDocuments.mockResolvedValue(2);

      // Act
      const result = await service.findByOrganizer(organizerId, { page: 1, limit: 10 });

      // Assert
      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ organizer: expect.any(Types.ObjectId) }),
      );
      expect(eventModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ organizer: expect.any(Types.ObjectId) }),
      );
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
    });

    // Non-régression : une pagination sans tri explicite s'appuie sur l'ordre
    // naturel de MongoDB, qui peut omettre ou dupliquer des documents entre
    // deux pages — et masquait un brouillon fraîchement créé au-delà de la
    // première page.
    it('devrait trier la page sur un ordre stable et déterministe', async () => {
      const chain = makeChainable([mockEvent()]);
      eventModel.find.mockReturnValue(chain);
      eventModel.countDocuments.mockResolvedValue(1);

      await service.findByOrganizer(organizerId, { page: 2, limit: 20 });

      expect(chain['sort']).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
    });

    it('applique recherche, vue, progression et tri côté serveur', async () => {
      const chain = makeChainable([mockEvent()]);
      eventModel.find.mockReturnValue(chain);

      await service.findByOrganizer(organizerId, {
        page: 1,
        limit: 12,
        view: OrganizerEventView.DRAFT,
        search: 'Montréal',
        progress: OrganizerEventProgress.INCOMPLETE,
        sort: OrganizerEventSort.TITLE_ASC,
      });

      expect(eventModel.find).toHaveBeenCalledWith(expect.objectContaining({
        organizer: expect.any(Types.ObjectId),
        archivedAt: null,
        status: EventStatus.DRAFT,
        $and: expect.arrayContaining([
          expect.objectContaining({ $or: expect.any(Array) }),
          expect.objectContaining({ $expr: expect.any(Object) }),
        ]),
      }));
      expect(chain['sort']).toHaveBeenCalledWith({ title: 1, _id: 1 });
    });

    it('compose les vues, filtres d’accès, dates et tris supportés', async () => {
      const chain = makeChainable([mockEvent()]);
      eventModel.find.mockReturnValue(chain);

      await service.findByOrganizer(organizerId, {
        view: OrganizerEventView.PUBLISHED,
        eventType: EventType.GALA,
        discoverability: EventDiscoverability.PUBLIC,
        accessPolicy: EventAccessPolicyType.OPEN,
        progress: OrganizerEventProgress.COMPLETE,
        date: OrganizerEventDate.UPCOMING,
        sort: OrganizerEventSort.DATE_ASC,
      });
      expect(eventModel.find).toHaveBeenLastCalledWith(expect.objectContaining({
        status: EventStatus.PUBLISHED,
        eventType: EventType.GALA,
        discoverability: 'public',
        'accessPolicy.type': 'open',
        startDate: expect.objectContaining({ $gte: expect.any(Date) }),
      }));
      expect(chain['sort']).toHaveBeenLastCalledWith({ startDate: 1, _id: 1 });

      await service.findByOrganizer(organizerId, {
        view: OrganizerEventView.COMPLETED,
        status: EventStatus.CANCELLED,
        date: OrganizerEventDate.PAST,
      });
      expect(eventModel.find).toHaveBeenLastCalledWith(expect.objectContaining({
        status: EventStatus.CANCELLED,
        startDate: expect.objectContaining({ $lt: expect.any(Date) }),
      }));

      await service.findByOrganizer(organizerId, {
        view: OrganizerEventView.ARCHIVED,
        date: OrganizerEventDate.UNDATED,
      });
      expect(eventModel.find).toHaveBeenLastCalledWith(expect.objectContaining({
        archivedAt: { $ne: null },
        $and: expect.arrayContaining([expect.objectContaining({ $or: expect.any(Array) })]),
      }));
    });

    it('retourne uniquement les brouillons réellement publiables dans la vue À publier', async () => {
      eventModel.find.mockReturnValue(makeChainable([
        mockEvent({ accessModelVersion: 2 }),
        mockEvent({ _id: new Types.ObjectId(), eventType: undefined, accessModelVersion: 2 }),
      ]));

      const result = await service.findByOrganizer(organizerId, {
        view: OrganizerEventView.READY,
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].readiness.publishable).toBe(true);
      expect(result.total).toBe(1);
    });
  });

  describe('dashboard organisateur', () => {
    it('calcule un résumé borné depuis les événements du propriétaire', async () => {
      const summary = await service.getOrganizerSummary(organizerId);

      expect(summary.metrics).toEqual({
        totalEvents: 1,
        activeEvents: 1,
        upcomingEvents: 1,
        draftEvents: 1,
        pendingActions: 1,
      });
      expect(summary.upcoming).toHaveLength(1);
      expect(summary.actions).toHaveLength(1);
      expect(summary.activityAvailable).toBe(false);
      expect(eventModel.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
        organizer: expect.any(Types.ObjectId),
        archivedAt: null,
      }));
    });

    it('priorise les demandes d’accès et agrège les inventaires sans N+1', async () => {
      const requestEventId = new Types.ObjectId();
      const requestEvent = mockEvent({
        _id: requestEventId,
        creationProgress: { completedSteps: [1, 2, 3] },
      });
      accessRequestModel.aggregate
        .mockResolvedValueOnce([{ _id: requestEventId, requestCount: 2, event: requestEvent }])
        .mockResolvedValue([{ _id: requestEventId, count: 2 }]);
      ticketTypeModel.aggregate.mockResolvedValue([
        { _id: requestEventId, freeTicketTypes: 1, paidTicketTypes: 0 },
      ]);

      const summary = await service.getOrganizerSummary(organizerId);

      expect(summary.actions[0]).toEqual(expect.objectContaining({
        code: 'REVIEW_ACCESS_REQUESTS',
        priority: 'high',
        requestCount: 2,
        progress: 50,
      }));
      expect(ticketTypeModel.aggregate).toHaveBeenCalledTimes(3);
      expect(accessRequestModel.aggregate).toHaveBeenCalledTimes(4);
    });
  });

  describe('archive', () => {
    it('archive puis restaure uniquement un événement possédé', async () => {
      await service.archive(eventId, organizerId);
      expect(eventModel.findByIdAndUpdate).toHaveBeenCalledWith(
        eventId,
        { archivedAt: expect.any(Date) },
        { new: true, runValidators: true },
      );

      await service.restore(eventId, organizerId);
      expect(eventModel.findByIdAndUpdate).toHaveBeenLastCalledWith(
        eventId,
        { archivedAt: null },
        { new: true, runValidators: true },
      );
    });

    it('refuse l’archive d’un événement appartenant à un tiers', async () => {
      await expect(service.archive(eventId, 'autre-user-id')).rejects.toThrow(ForbiddenException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refuse l’archive d’un événement inexistant', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));
      await expect(service.archive('id-inexistant', organizerId)).rejects.toThrow(NotFoundException);
    });
  });
});
