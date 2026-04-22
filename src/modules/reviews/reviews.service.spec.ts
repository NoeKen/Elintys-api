import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ReviewsService } from './reviews.service';
import { Review, ReviewTargetType } from './review.schema';

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('ReviewsService', () => {
  let service: ReviewsService;
  let reviewModel: Record<string, jest.Mock>;

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
    deleteOne: jest.fn().mockResolvedValue({}),
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    reviewModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    reviewModel.findOne.mockReturnValue(makeChainable(null));
    reviewModel.find.mockReturnValue(makeChainable([mockReview()]));
    reviewModel.countDocuments.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getModelToken(Review.name), useValue: reviewModel },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ──
  describe('create', () => {
    it('crée un avis et le retourne', async () => {
      const dto = {
        targetType: ReviewTargetType.EVENT,
        targetId,
        rating: 5,
        comment: 'Excellent événement!',
      };
      reviewModel.create.mockResolvedValue(mockReview(dto));

      const result = await service.create(authorId, dto as never);

      expect(reviewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ rating: 5 }),
      );
      expect(result).toBeDefined();
    });

    it('lève ConflictException si l\'utilisateur a déjà laissé un avis sur cette cible', async () => {
      reviewModel.findOne.mockReturnValue(makeChainable({ _id: reviewId }));

      await expect(
        service.create(authorId, {
          targetType: ReviewTargetType.EVENT,
          targetId,
          rating: 4,
          comment: 'Bien',
        } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── findForTarget ──
  describe('findForTarget', () => {
    it('retourne les avis paginés pour une cible', async () => {
      const result = await service.findForTarget(ReviewTargetType.EVENT, targetId, 1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(reviewModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: ReviewTargetType.EVENT }),
      );
    });

    it('retourne une liste vide si aucun avis pour cette cible', async () => {
      reviewModel.find.mockReturnValue(makeChainable([]));
      reviewModel.countDocuments.mockResolvedValue(0);

      const otherTargetId = new Types.ObjectId().toString();
      const result = await service.findForTarget(ReviewTargetType.VENDOR, otherTargetId, 1, 20);

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('supprime l\'avis si l\'auteur correspond', async () => {
      const review = mockReview();
      reviewModel.findOne.mockResolvedValue(review);

      await expect(service.remove(reviewId, authorId)).resolves.toBeUndefined();
      expect(review.deleteOne).toHaveBeenCalled();
    });

    it('lève NotFoundException si l\'avis est introuvable ou n\'appartient pas à l\'auteur', async () => {
      reviewModel.findOne.mockResolvedValue(null);

      await expect(service.remove('id-inexistant', authorId)).rejects.toThrow(NotFoundException);
    });
  });
});
