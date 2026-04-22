import { Test, TestingModule } from '@nestjs/testing';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';
import { FavoriteTargetType } from './favorite.schema';

const mockFavoritesService = {
  add: jest.fn(),
  findMyFavorites: jest.fn(),
  remove: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['participant'] };

describe('FavoritesController', () => {
  let controller: FavoritesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FavoritesController],
      providers: [{ provide: FavoritesService, useValue: mockFavoritesService }],
    }).compile();

    controller = module.get<FavoritesController>(FavoritesController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /favorites ──
  describe('add', () => {
    it('délègue à favoritesService.add avec user.sub et le DTO', async () => {
      const dto = { targetType: FavoriteTargetType.EVENT, targetId: 'event-id' };
      mockFavoritesService.add.mockResolvedValue({ _id: 'fav-id', ...dto });

      await controller.add(mockUser as never, dto as never);

      expect(mockFavoritesService.add).toHaveBeenCalledWith(mockUser.sub, dto);
    });
  });

  // ── GET /favorites ──
  describe('findMine', () => {
    it('délègue à favoritesService.findMyFavorites sans filtre', async () => {
      mockFavoritesService.findMyFavorites.mockResolvedValue([]);

      await controller.findMine(mockUser as never, undefined);

      expect(mockFavoritesService.findMyFavorites).toHaveBeenCalledWith(mockUser.sub, undefined);
    });

    it('délègue à favoritesService.findMyFavorites avec le filtre de type', async () => {
      mockFavoritesService.findMyFavorites.mockResolvedValue([]);

      await controller.findMine(mockUser as never, FavoriteTargetType.VENDOR);

      expect(mockFavoritesService.findMyFavorites).toHaveBeenCalledWith(
        mockUser.sub,
        FavoriteTargetType.VENDOR,
      );
    });
  });

  // ── DELETE /favorites ──
  describe('remove', () => {
    it('délègue à favoritesService.remove avec user.sub et le DTO', async () => {
      const dto = { targetType: FavoriteTargetType.EVENT, targetId: 'event-id' };
      mockFavoritesService.remove.mockResolvedValue(undefined);

      await controller.remove(mockUser as never, dto as never);

      expect(mockFavoritesService.remove).toHaveBeenCalledWith(mockUser.sub, dto);
    });
  });
});
