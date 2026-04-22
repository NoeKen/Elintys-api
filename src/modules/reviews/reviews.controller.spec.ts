import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

const mockReviewsService = {
  create: jest.fn(),
  findForTarget: jest.fn(),
  remove: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['participant'] };

describe('ReviewsController', () => {
  let controller: ReviewsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [{ provide: ReviewsService, useValue: mockReviewsService }],
    }).compile();

    controller = module.get<ReviewsController>(ReviewsController);
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
    it('délègue à reviewsService.findForTarget avec les paramètres par défaut', async () => {
      mockReviewsService.findForTarget.mockResolvedValue({ data: [], total: 0 });

      await controller.findForTarget('event', 'target-id', undefined, undefined);

      expect(mockReviewsService.findForTarget).toHaveBeenCalledWith('event', 'target-id', 1, 20);
    });

    it('passe les valeurs de page et limit parsées', async () => {
      mockReviewsService.findForTarget.mockResolvedValue({ data: [], total: 0 });

      await controller.findForTarget('vendor', 'vendor-id', '2', '10');

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
