import { Test, TestingModule } from '@nestjs/testing';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

const mockGuestsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('GuestsController', () => {
  let controller: GuestsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GuestsController],
      providers: [{ provide: GuestsService, useValue: mockGuestsService }],
    }).compile();

    controller = module.get<GuestsController>(GuestsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /events/:eventId/guests ──
  describe('create', () => {
    it('délègue à guestsService.create avec eventId, user.sub et le DTO', async () => {
      const dto = { name: 'Marie Dupont', email: 'marie@test.com' };
      mockGuestsService.create.mockResolvedValue({ _id: 'guest-id', ...dto });

      await controller.create('event-id', mockUser as never, dto as never);

      expect(mockGuestsService.create).toHaveBeenCalledWith('event-id', mockUser.sub, dto);
    });
  });

  // ── GET /events/:eventId/guests ──
  describe('findAll', () => {
    it('délègue à guestsService.findAll avec les paramètres par défaut', async () => {
      mockGuestsService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll('event-id', mockUser as never, undefined, undefined);

      expect(mockGuestsService.findAll).toHaveBeenCalledWith('event-id', mockUser.sub, 1, 50);
    });

    it('passe les valeurs de page et limit parsées', async () => {
      mockGuestsService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll('event-id', mockUser as never, '2', '25');

      expect(mockGuestsService.findAll).toHaveBeenCalledWith('event-id', mockUser.sub, 2, 25);
    });
  });

  // ── PUT /events/:eventId/guests/:id ──
  describe('update', () => {
    it('délègue à guestsService.update avec l\'id, eventId, user.sub et le DTO', async () => {
      const dto = { status: 'confirmed' };
      mockGuestsService.update.mockResolvedValue({ _id: 'guest-id', ...dto });

      await controller.update('event-id', 'guest-id', mockUser as never, dto as never);

      expect(mockGuestsService.update).toHaveBeenCalledWith('guest-id', 'event-id', mockUser.sub, dto);
    });
  });

  // ── DELETE /events/:eventId/guests/:id ──
  describe('remove', () => {
    it('délègue à guestsService.remove avec l\'id, eventId et user.sub', async () => {
      mockGuestsService.remove.mockResolvedValue(undefined);

      await controller.remove('event-id', 'guest-id', mockUser as never);

      expect(mockGuestsService.remove).toHaveBeenCalledWith('guest-id', 'event-id', mockUser.sub);
    });
  });
});
