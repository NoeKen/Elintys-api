import { Test, TestingModule } from '@nestjs/testing';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventMediaService } from './event-media.service';
import { EventAccessService } from './event-access.service';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockEventsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  getPublicCategoryCounts: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  publish: jest.fn(),
  cancel: jest.fn(),
  findByOrganizer: jest.fn(),
  getOrganizerSummary: jest.fn(),
  archive: jest.fn(),
  restore: jest.fn(),
  findBySlug: jest.fn(),
};
const mockEventMediaService = {
  uploadCover: jest.fn(),
  deleteCover: jest.fn(),
  uploadGallery: jest.fn(),
  deleteGalleryImage: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('EventsController', () => {
  let controller: EventsController;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        { provide: EventsService, useValue: mockEventsService },
        { provide: EventMediaService, useValue: mockEventMediaService },
        { provide: EventAccessService, useValue: {} },
      ],
    }).compile();

    controller = testingModule.get<EventsController>(EventsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /events ──
  describe('create', () => {
    it('délègue à eventsService.create avec user.sub et le DTO', async () => {
      const dto = { title: 'Gala', startDate: '2025-09-01' };
      mockEventsService.create.mockResolvedValue({ _id: 'new-id', ...dto });

      await controller.create(mockUser as never, dto as never);

      expect(mockEventsService.create).toHaveBeenCalledWith(mockUser.sub, dto);
    });
  });

  // ── GET /events ──
  describe('findAll', () => {
    it('délègue à eventsService.findAll avec les query params', async () => {
      const query = { page: 1, limit: 10 };
      mockEventsService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(query as never);

      expect(mockEventsService.findAll).toHaveBeenCalledWith(query);
    });
  });

  describe('getCategoryCounts', () => {
    it('délègue l’agrégation à eventsService', async () => {
      mockEventsService.getPublicCategoryCounts.mockResolvedValue({
        data: [],
        total: 0,
      });

      await controller.getCategoryCounts();

      expect(mockEventsService.getPublicCategoryCounts).toHaveBeenCalled();
    });
  });

  describe('findBySlug', () => {
    it('délègue la projection publique au service sans contexte utilisateur', async () => {
      mockEventsService.findBySlug.mockResolvedValue({ slug: 'gala-public' });

      await controller.findBySlug('gala-public');

      expect(mockEventsService.findBySlug).toHaveBeenCalledWith('gala-public');
    });
  });

  describe('surfaces organisateur', () => {
    it('dérive la liste et le résumé de user.sub', async () => {
      const query = { page: 2, limit: 12 };
      await controller.findMyEvents(mockUser as never, query as never);
      await controller.getMyEventsSummary(mockUser as never);

      expect(mockEventsService.findByOrganizer).toHaveBeenCalledWith(mockUser.sub, query);
      expect(mockEventsService.getOrganizerSummary).toHaveBeenCalledWith(mockUser.sub);
    });

    it('dérive archive et restauration de user.sub', async () => {
      await controller.archive('event-id', mockUser as never);
      await controller.restore('event-id', mockUser as never);

      expect(mockEventsService.archive).toHaveBeenCalledWith('event-id', mockUser.sub);
      expect(mockEventsService.restore).toHaveBeenCalledWith('event-id', mockUser.sub);
    });
  });

  // ── GET /events/:id ──
  describe('findOne', () => {
    it('délègue à eventsService.findOne avec l\'ID', async () => {
      mockEventsService.findOne.mockResolvedValue({ _id: 'event-id' });

      await controller.findOne('event-id', mockUser as never);

      expect(mockEventsService.findOne).toHaveBeenCalledWith('event-id', mockUser.sub);
    });
  });

  // ── PATCH /events/:id ──
  describe('patch', () => {
    it('délègue à eventsService.update avec l’ID, user.sub et le DTO', async () => {
      const dto = { shortDescription: 'Une soirée mémorable' };
      mockEventsService.update.mockResolvedValue({ _id: 'event-id', ...dto });

      await controller.patch('event-id', mockUser as never, dto as never);

      expect(mockEventsService.update).toHaveBeenCalledWith('event-id', mockUser.sub, dto);
    });
  });

  // ── PUT /events/:id ──
  describe('update', () => {
    it('délègue à eventsService.update avec l\'ID, user.sub et le DTO', async () => {
      const dto = { title: 'Titre modifié' };
      mockEventsService.update.mockResolvedValue({ _id: 'event-id', ...dto });

      await controller.update('event-id', mockUser as never, dto as never);

      expect(mockEventsService.update).toHaveBeenCalledWith('event-id', mockUser.sub, dto);
    });
  });

  describe('event media', () => {
    it('délègue le téléversement de couverture au service média', async () => {
      const file = { buffer: Buffer.from('image') };
      mockEventMediaService.uploadCover.mockResolvedValue({
        coverImage: { publicId: 'cover' },
        gallery: [],
      });

      await controller.uploadCover(
        'event-id',
        mockUser as never,
        file as never,
      );

      expect(mockEventMediaService.uploadCover).toHaveBeenCalledWith(
        'event-id',
        mockUser.sub,
        file,
      );
    });

    it('délègue la suppression d’une image de galerie avec son publicId', async () => {
      mockEventMediaService.deleteGalleryImage.mockResolvedValue({
        coverImage: null,
        gallery: [],
      });

      await controller.deleteGalleryImage(
        'event-id',
        mockUser as never,
        { publicId: 'Elintys/dev/events/event-id/gallery/image' },
      );

      expect(mockEventMediaService.deleteGalleryImage).toHaveBeenCalledWith(
        'event-id',
        mockUser.sub,
        'Elintys/dev/events/event-id/gallery/image',
      );
    });
  });

  // ── DELETE /events/:id ──
  describe('remove', () => {
    it('délègue à eventsService.remove avec l\'ID et user.sub', async () => {
      mockEventsService.remove.mockResolvedValue(undefined);

      await controller.remove('event-id', mockUser as never);

      expect(mockEventsService.remove).toHaveBeenCalledWith('event-id', mockUser.sub);
    });
  });

  // ── PATCH /events/:id/publish ──
  describe('publish', () => {
    it('délègue à eventsService.publish avec l\'ID et user.sub', async () => {
      mockEventsService.publish.mockResolvedValue({ status: 'published' });

      await controller.publish('event-id', mockUser as never);

      expect(mockEventsService.publish).toHaveBeenCalledWith('event-id', mockUser.sub);
    });
  });

  // ── PATCH /events/:id/cancel ──
  describe('cancel', () => {
    it('délègue à eventsService.cancel avec l\'ID et user.sub', async () => {
      mockEventsService.cancel.mockResolvedValue({ status: 'cancelled' });

      await controller.cancel('event-id', mockUser as never);

      expect(mockEventsService.cancel).toHaveBeenCalledWith('event-id', mockUser.sub);
    });
  });
});
