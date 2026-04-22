import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { FavoritesService } from './favorites.service';
import { Favorite, FavoriteTargetType } from './favorite.schema';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('FavoritesService', () => {
  let service: FavoritesService;
  let favoriteModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();

  const mockFavorite = (overrides = {}) => ({
    _id: new Types.ObjectId().toString(),
    user: new Types.ObjectId(userId),
    targetType: FavoriteTargetType.EVENT,
    targetId: new Types.ObjectId(targetId),
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    favoriteModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndDelete: jest.fn(),
      create: jest.fn(),
    };

    favoriteModel.findOne.mockReturnValue(makeChainable(null));
    favoriteModel.find.mockReturnValue(makeChainable([mockFavorite()]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FavoritesService,
        { provide: getModelToken(Favorite.name), useValue: favoriteModel },
      ],
    }).compile();

    service = module.get<FavoritesService>(FavoritesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── add ──
  describe('add', () => {
    it('ajoute un favori et le retourne', async () => {
      const dto = { targetType: FavoriteTargetType.EVENT, targetId };
      favoriteModel.create.mockResolvedValue(mockFavorite());

      const result = await service.add(userId, dto as never);

      expect(favoriteModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: FavoriteTargetType.EVENT }),
      );
      expect(result).toBeDefined();
    });

    it('lève ConflictException si le favori existe déjà', async () => {
      favoriteModel.findOne.mockReturnValue(makeChainable({ _id: 'fav-id' }));

      await expect(
        service.add(userId, { targetType: FavoriteTargetType.EVENT, targetId } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── findMyFavorites ──
  describe('findMyFavorites', () => {
    it('retourne tous les favoris de l\'utilisateur', async () => {
      const result = await service.findMyFavorites(userId);

      expect(result).toHaveLength(1);
      expect(favoriteModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.any(Types.ObjectId) }),
      );
    });

    it('filtre par targetType si fourni', async () => {
      favoriteModel.find.mockReturnValue(makeChainable([]));

      await service.findMyFavorites(userId, FavoriteTargetType.VENDOR);

      expect(favoriteModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: FavoriteTargetType.VENDOR }),
      );
    });

    it('ne filtre pas par targetType si non fourni', async () => {
      await service.findMyFavorites(userId);

      const callArg = favoriteModel.find.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg).not.toHaveProperty('targetType');
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('supprime le favori correspondant', async () => {
      favoriteModel.findOneAndDelete.mockResolvedValue({ _id: 'fav-id' });

      await expect(
        service.remove(userId, { targetType: FavoriteTargetType.EVENT, targetId } as never),
      ).resolves.toBeUndefined();
      expect(favoriteModel.findOneAndDelete).toHaveBeenCalled();
    });

    it('lève NotFoundException si le favori n\'existe pas', async () => {
      favoriteModel.findOneAndDelete.mockResolvedValue(null);

      await expect(
        service.remove(userId, { targetType: FavoriteTargetType.EVENT, targetId } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
