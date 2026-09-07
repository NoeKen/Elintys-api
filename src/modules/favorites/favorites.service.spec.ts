import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { FavoritesService } from './favorites.service';
import { Favorite, FavoriteTargetType } from './favorite.schema';
import { Event, EventStatus } from '../events/event.schema';
import { VendorProfile } from '../vendors/vendor.schema';
import { VenueProfile } from '../venues/venue.schema';
import { ErrorCodes } from '../../shared/constants/error-codes';

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

/** Erreur MongoServerError d'unicité, telle que remontée par le driver. */
const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

describe('FavoritesService', () => {
  let service: FavoritesService;
  let favoriteModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;
  let vendorModel: Record<string, jest.Mock>;
  let venueModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const eventTargetId = new Types.ObjectId().toString();
  const vendorTargetId = new Types.ObjectId().toString();
  const venueTargetId = new Types.ObjectId().toString();

  const mockFavorite = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    user: new Types.ObjectId(userId),
    targetType: FavoriteTargetType.EVENT,
    targetId: new Types.ObjectId(eventTargetId),
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
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
    eventModel = { exists: jest.fn(), find: jest.fn() };
    vendorModel = { exists: jest.fn(), find: jest.fn() };
    venueModel = { exists: jest.fn(), find: jest.fn() };

    // Par défaut la cible existe : les tests qui veulent l'inverse le disent.
    eventModel.exists.mockResolvedValue({ _id: new Types.ObjectId(eventTargetId) });
    vendorModel.exists.mockResolvedValue({ _id: new Types.ObjectId(vendorTargetId) });
    venueModel.exists.mockResolvedValue({ _id: new Types.ObjectId(venueTargetId) });
    eventModel.find.mockReturnValue(makeChainable([]));
    vendorModel.find.mockReturnValue(makeChainable([]));
    venueModel.find.mockReturnValue(makeChainable([]));

    favoriteModel.findOne.mockReturnValue(makeChainable(null));
    favoriteModel.find.mockReturnValue(makeChainable([mockFavorite()]));

    testingModule = await Test.createTestingModule({
      providers: [
        FavoritesService,
        { provide: getModelToken(Favorite.name), useValue: favoriteModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
      ],
    }).compile();

    service = testingModule.get<FavoritesService>(FavoritesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── add ──
  describe('add', () => {
    it('ajoute un favori et le retourne', async () => {
      favoriteModel.create.mockResolvedValue(mockFavorite());

      const result = await service.add(userId, {
        targetType: FavoriteTargetType.EVENT,
        targetId: eventTargetId,
      });

      expect(favoriteModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: FavoriteTargetType.EVENT }),
      );
      expect(result).toBeDefined();
    });

    it("refuse une cible inexistante avec un 404 métier", async () => {
      // Sans cette garde, l'API accepte n'importe quel ObjectId bien formé et
      // l'utilisateur accumule des favoris qui n'afficheront jamais rien.
      eventModel.exists.mockResolvedValue(null);

      await expect(
        service.add(userId, { targetType: FavoriteTargetType.EVENT, targetId: eventTargetId }),
      ).rejects.toMatchObject({ message: ErrorCodes.FAVORITE_TARGET_NOT_FOUND });
      expect(favoriteModel.create).not.toHaveBeenCalled();
    });

    it.each([
      [FavoriteTargetType.EVENT, 'eventModel'],
      [FavoriteTargetType.VENDOR, 'vendorModel'],
      [FavoriteTargetType.VENUE, 'venueModel'],
    ])('vérifie la cible dans la bonne collection pour le type %s', async (targetType) => {
      favoriteModel.create.mockResolvedValue(mockFavorite({ targetType }));
      const ids: Record<FavoriteTargetType, string> = {
        [FavoriteTargetType.EVENT]: eventTargetId,
        [FavoriteTargetType.VENDOR]: vendorTargetId,
        [FavoriteTargetType.VENUE]: venueTargetId,
      };

      await service.add(userId, { targetType, targetId: ids[targetType] });

      const expected = {
        [FavoriteTargetType.EVENT]: eventModel,
        [FavoriteTargetType.VENDOR]: vendorModel,
        [FavoriteTargetType.VENUE]: venueModel,
      }[targetType];
      expect(expected.exists).toHaveBeenCalled();
    });

    it('ne permet pas aux favoris de contourner la visibilité des événements', async () => {
      favoriteModel.create.mockResolvedValue(mockFavorite());

      await service.add(userId, {
        targetType: FavoriteTargetType.EVENT,
        targetId: eventTargetId,
      });

      expect(eventModel.exists).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EventStatus.PUBLISHED,
          archivedAt: null,
          $or: expect.any(Array),
        }),
      );
    });

    it.each([
      [FavoriteTargetType.VENDOR, vendorTargetId, 'vendorModel'],
      [FavoriteTargetType.VENUE, venueTargetId, 'venueModel'],
    ])('exige une cible active pour %s', async (targetType, targetId, modelName) => {
      favoriteModel.create.mockResolvedValue(mockFavorite({ targetType }));

      await service.add(userId, { targetType, targetId });

      const model = modelName === 'vendorModel' ? vendorModel : venueModel;
      expect(model.exists).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
      );
    });

    it('traduit une violation d’index unique en conflit métier', async () => {
      // L'index {user, targetType, targetId} est l'autorité : deux clics
      // concurrents ne doivent produire ni doublon ni 500.
      favoriteModel.create.mockRejectedValue(duplicateKeyError());

      await expect(
        service.add(userId, { targetType: FavoriteTargetType.EVENT, targetId: eventTargetId }),
      ).rejects.toThrow(ConflictException);
    });

    it('ne masque pas une erreur non liée à l’unicité', async () => {
      favoriteModel.create.mockRejectedValue(new Error('connexion perdue'));

      await expect(
        service.add(userId, { targetType: FavoriteTargetType.EVENT, targetId: eventTargetId }),
      ).rejects.toThrow('connexion perdue');
    });
  });

  // ── findMyFavorites ──
  describe('findMyFavorites', () => {
    it("retourne les favoris de l'utilisateur", async () => {
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

    it('enrichit chaque favori avec un libellé et un lien public exploitables', async () => {
      eventModel.find.mockReturnValue(
        makeChainable([
          {
            _id: new Types.ObjectId(eventTargetId),
            title: 'Gala annuel',
            slug: 'gala-annuel',
            startDate: new Date('2026-12-01T00:00:00.000Z'),
            coverImage: { url: 'https://cdn/cover.jpg' },
            location: { city: 'Montréal' },
          },
        ]),
      );

      const [favorite] = await service.findMyFavorites(userId);

      // L'UI ne doit plus jamais afficher un ObjectId brut.
      expect(favorite.target?.label).toBe('Gala annuel');
      expect(favorite.target?.href).toBe('/evenements/gala-annuel');
      expect(favorite.target?.imageUrl).toBe('https://cdn/cover.jpg');
      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: EventStatus.PUBLISHED, archivedAt: null }),
      );
    });

    it("n'invente pas de lien pour un événement sans slug", async () => {
      eventModel.find.mockReturnValue(
        makeChainable([{ _id: new Types.ObjectId(eventTargetId), title: 'Brouillon' }]),
      );

      const [favorite] = await service.findMyFavorites(userId);

      expect(favorite.target?.label).toBe('Brouillon');
      expect(favorite.target?.href).toBeUndefined();
    });

    it('expose target: null lorsque la cible a été supprimée', async () => {
      // Distinguable d'une erreur de chargement côté client.
      eventModel.find.mockReturnValue(makeChainable([]));

      const [favorite] = await service.findMyFavorites(userId);

      expect(favorite.target).toBeNull();
      expect(favorite.targetId).toBe(eventTargetId);
    });

    it("n'émet qu'une requête d'enrichissement par type, jamais une par favori", async () => {
      // Garde anti-N+1 : 3 favoris événement ⇒ 1 seul find sur les événements.
      const many = [
        mockFavorite({ targetId: new Types.ObjectId(eventTargetId) }),
        mockFavorite({ targetId: new Types.ObjectId() }),
        mockFavorite({ targetId: new Types.ObjectId() }),
      ];
      favoriteModel.find.mockReturnValue(makeChainable(many));

      await service.findMyFavorites(userId);

      expect(eventModel.find).toHaveBeenCalledTimes(1);
      expect(vendorModel.find).not.toHaveBeenCalled();
      expect(venueModel.find).not.toHaveBeenCalled();
    });

    it('retourne une liste vide sans interroger les collections cibles', async () => {
      favoriteModel.find.mockReturnValue(makeChainable([]));

      const result = await service.findMyFavorites(userId);

      expect(result).toEqual([]);
      expect(eventModel.find).not.toHaveBeenCalled();
    });

    it('enrichit prestataires et lieux avec leur lien public respectif', async () => {
      favoriteModel.find.mockReturnValue(
        makeChainable([
          mockFavorite({
            targetType: FavoriteTargetType.VENDOR,
            targetId: new Types.ObjectId(vendorTargetId),
          }),
          mockFavorite({
            targetType: FavoriteTargetType.VENUE,
            targetId: new Types.ObjectId(venueTargetId),
          }),
        ]),
      );
      vendorModel.find.mockReturnValue(
        makeChainable([
          {
            _id: new Types.ObjectId(vendorTargetId),
            businessName: 'Lumière Nord',
            photos: ['https://cdn/v.jpg'],
            serviceArea: 'Grand Montréal',
          },
        ]),
      );
      venueModel.find.mockReturnValue(
        makeChainable([
          {
            _id: new Types.ObjectId(venueTargetId),
            name: 'Salle Saint-Paul',
            photos: [],
            address: { city: 'Montréal' },
          },
        ]),
      );

      const result = await service.findMyFavorites(userId);

      expect(result[0].target?.href).toBe(`/prestataires/${vendorTargetId}`);
      expect(result[0].target?.label).toBe('Lumière Nord');
      expect(result[1].target?.href).toBe(`/lieux/${venueTargetId}`);
      expect(result[1].target?.label).toBe('Salle Saint-Paul');
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('supprime le favori correspondant', async () => {
      favoriteModel.findOneAndDelete.mockResolvedValue({ _id: 'fav-id' });

      await expect(
        service.remove(userId, { targetType: FavoriteTargetType.EVENT, targetId: eventTargetId }),
      ).resolves.toBeUndefined();
      expect(favoriteModel.findOneAndDelete).toHaveBeenCalled();
    });

    it("lève NotFoundException si le favori n'existe pas", async () => {
      favoriteModel.findOneAndDelete.mockResolvedValue(null);

      await expect(
        service.remove(userId, { targetType: FavoriteTargetType.EVENT, targetId: eventTargetId }),
      ).rejects.toThrow(NotFoundException);
    });

    it("ne supprime que le favori de l'utilisateur courant", async () => {
      favoriteModel.findOneAndDelete.mockResolvedValue({ _id: 'fav-id' });

      await service.remove(userId, {
        targetType: FavoriteTargetType.EVENT,
        targetId: eventTargetId,
      });

      const [filter] = favoriteModel.findOneAndDelete.mock.calls[0] as [{ user: Types.ObjectId }];
      expect(filter.user.toString()).toBe(userId);
    });
  });
});
