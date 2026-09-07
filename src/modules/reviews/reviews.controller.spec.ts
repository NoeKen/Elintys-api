import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { ReviewTargetType } from './review.schema';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockReviewsService = {
  create: jest.fn(),
  findForTarget: jest.fn(),
  remove: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['participant'] };

describe('ReviewsController', () => {
  let controller: ReviewsController;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [{ provide: ReviewsService, useValue: mockReviewsService }],
    }).compile();

    controller = testingModule.get<ReviewsController>(ReviewsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /reviews ──
  describe('create', () => {
    it('délègue à reviewsService.create avec user.sub et le DTO', async () => {
      const dto = { targetType: 'event', targetId: 'target-id', rating: 5, comment: 'Super!' };
      mockReviewsService.create.mockResolvedValue({ _id: 'review-id', ...dto });

      await controller.create(mockUser as never, dto as never);

      expect(mockReviewsService.create).toHaveBeenCalledWith(mockUser.sub, dto);
    });
  });

  // ── GET /reviews/:targetType/:targetId ──
  describe('findForTarget', () => {
    it('délègue le type validé et la pagination par défaut', async () => {
      mockReviewsService.findForTarget.mockResolvedValue({ data: [], total: 0 });

      await controller.findForTarget(
        { targetType: ReviewTargetType.EVENT, targetId: 'target-id' },
        { page: 1, limit: 20 },
      );

      expect(mockReviewsService.findForTarget).toHaveBeenCalledWith('event', 'target-id', 1, 20);
    });

    it('transmet la pagination demandée', async () => {
      mockReviewsService.findForTarget.mockResolvedValue({ data: [], total: 0 });

      await controller.findForTarget(
        { targetType: ReviewTargetType.VENDOR, targetId: 'vendor-id' },
        { page: 2, limit: 10 },
      );

      expect(mockReviewsService.findForTarget).toHaveBeenCalledWith('vendor', 'vendor-id', 2, 10);
    });
  });

  // ── DELETE /reviews/:id ──
  describe('remove', () => {
    it('délègue à reviewsService.remove avec l\'ID et user.sub', async () => {
      mockReviewsService.remove.mockResolvedValue(undefined);

      await controller.remove('review-id', mockUser as never);

      expect(mockReviewsService.remove).toHaveBeenCalledWith('review-id', mockUser.sub);
    });
  });
});
