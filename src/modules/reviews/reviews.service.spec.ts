import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ReviewsService } from './reviews.service';
import { Review, ReviewTargetType } from './review.schema';
import { Event } from '../events/event.schema';
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

const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

describe('ReviewsService', () => {
  let service: ReviewsService;
  let reviewModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;
  let vendorModel: Record<string, jest.Mock>;
  let venueModel: Record<string, jest.Mock>;

  const authorId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const reviewId = new Types.ObjectId().toString();

  const mockReview = (overrides = {}) => ({
    _id: reviewId,
    author: { toString: () => authorId },
    targetType: ReviewTargetType.EVENT,
    targetId: new Types.ObjectId(targetId),
    rating: 5,
    comment: 'Excellent événement!',
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  const dto = {
    targetType: ReviewTargetType.EVENT,
    targetId,
    rating: 5,
    comment: 'Excellent événement!',
  };

  beforeEach(async () => {
    reviewModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };
    eventModel = { exists: jest.fn() };
    vendorModel = { exists: jest.fn() };
    venueModel = { exists: jest.fn() };

    // Par défaut la cible existe : les tests qui veulent l'inverse le disent.
    eventModel.exists.mockResolvedValue({ _id: new Types.ObjectId(targetId) });
    vendorModel.exists.mockResolvedValue({ _id: new Types.ObjectId(targetId) });
    venueModel.exists.mockResolvedValue({ _id: new Types.ObjectId(targetId) });

    reviewModel.findOne.mockReturnValue(makeChainable(null));
    reviewModel.findById.mockReturnValue(makeChainable(mockReview()));
    reviewModel.find.mockReturnValue(makeChainable([mockReview()]));
    reviewModel.countDocuments.mockResolvedValue(1);
    reviewModel.findByIdAndDelete.mockResolvedValue({});

    testingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getModelToken(Review.name), useValue: reviewModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
      ],
    }).compile();

    service = testingModule.get<ReviewsService>(ReviewsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('crée un avis et le retourne', async () => {
      reviewModel.create.mockResolvedValue(mockReview());

      await expect(service.create(authorId, dto)).resolves.toBeDefined();
      expect(reviewModel.create).toHaveBeenCalled();
    });

    it('refuse une cible inexistante avec un 404 métier', async () => {
      // Sans cette garde, l'API acceptait un avis sur n'importe quel ObjectId
      // bien formé et accumulait des avis orphelins.
      eventModel.exists.mockResolvedValue(null);

      await expect(service.create(authorId, dto)).rejects.toMatchObject({
        message: ErrorCodes.REVIEW_TARGET_NOT_FOUND,
      });
      expect(reviewModel.create).not.toHaveBeenCalled();
    });

    it.each([
      [ReviewTargetType.EVENT, 'eventModel'],
      [ReviewTargetType.VENDOR, 'vendorModel'],
      [ReviewTargetType.VENUE, 'venueModel'],
    ])('vérifie la cible dans la bonne collection pour %s', async (targetType) => {
      reviewModel.create.mockResolvedValue(mockReview({ targetType }));

      await service.create(authorId, { ...dto, targetType });

      const expected = { eventModel, vendorModel, venueModel }[
        { event: 'eventModel', vendor: 'vendorModel', venue: 'venueModel' }[targetType] as
          | 'eventModel'
          | 'vendorModel'
          | 'venueModel'
      ];
      expect(expected.exists).toHaveBeenCalled();
    });

    it('traduit une violation d’index unique en conflit métier', async () => {
      // L'index {author, targetType, targetId} est l'autorité : deux
      // soumissions concurrentes ne peuvent pas créer deux avis.
      reviewModel.create.mockRejectedValue(duplicateKeyError());

      await expect(service.create(authorId, dto)).rejects.toThrow(ConflictException);
    });

    it('ne masque pas une erreur non liée à l’unicité', async () => {
      reviewModel.create.mockRejectedValue(new Error('connexion perdue'));

      await expect(service.create(authorId, dto)).rejects.toThrow('connexion perdue');
    });
  });

  describe('findForTarget', () => {
    it('retourne les avis paginés pour une cible', async () => {
      const result = await service.findForTarget(ReviewTargetType.EVENT, targetId, 1, 20);

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('retourne une liste vide si aucun avis', async () => {
      reviewModel.find.mockReturnValue(makeChainable([]));
      reviewModel.countDocuments.mockResolvedValue(0);

      const result = await service.findForTarget(ReviewTargetType.VENUE, targetId);

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("n'expose pas le document brut de l'auteur", async () => {
      await service.findForTarget(ReviewTargetType.EVENT, targetId);

      const chain = reviewModel.find.mock.results[0].value as Record<string, jest.Mock>;
      expect(chain.populate).toHaveBeenCalledWith('author', 'fullName');
      const projection = chain.select.mock.calls[0][0] as string;
      expect(projection).not.toContain('-__v');
    });
  });

  describe('remove', () => {
    it("supprime l'avis de son auteur", async () => {
      await expect(service.remove(reviewId, authorId)).resolves.toBeUndefined();
      expect(reviewModel.findByIdAndDelete).toHaveBeenCalledWith(reviewId);
    });

    it('lève NotFoundException si l’avis n’existe pas', async () => {
      reviewModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.remove(reviewId, authorId)).rejects.toThrow(NotFoundException);
    });

    it('lève ForbiddenException sur l’avis d’un autre auteur', async () => {
      // Auparavant les deux cas partageaient un 404 « introuvable ou accès
      // refusé » : les avis étant publics, distinguer ne divulgue rien.
      reviewModel.findById.mockReturnValue(
        makeChainable({ author: { toString: () => new Types.ObjectId().toString() } }),
      );

      await expect(service.remove(reviewId, authorId)).rejects.toThrow(ForbiddenException);
      expect(reviewModel.findByIdAndDelete).not.toHaveBeenCalled();
    });
  });
});
