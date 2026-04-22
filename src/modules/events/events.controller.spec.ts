import { Test, TestingModule } from '@nestjs/testing';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

const mockEventsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  publish: jest.fn(),
  cancel: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('EventsController', () => {
  let controller: EventsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [{ provide: EventsService, useValue: mockEventsService }],
    }).compile();

    controller = module.get<EventsController>(EventsController);
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

  // ── GET /events/:id ──
  describe('findOne', () => {
    it('délègue à eventsService.findOne avec l\'ID', async () => {
      mockEventsService.findOne.mockResolvedValue({ _id: 'event-id' });

      await controller.findOne('event-id');

      expect(mockEventsService.findOne).toHaveBeenCalledWith('event-id');
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
