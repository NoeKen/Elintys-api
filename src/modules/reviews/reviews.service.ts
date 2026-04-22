import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Review, ReviewDocument } from './review.schema';
import { CreateReviewDto } from './dto/create-review.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review.name) private readonly reviewModel: Model<ReviewDocument>,
  ) {}

  async create(authorId: string, dto: CreateReviewDto): Promise<Review> {
    const exists = await this.reviewModel
      .findOne({
        author: new Types.ObjectId(authorId),
        targetType: dto.targetType,
        targetId: new Types.ObjectId(dto.targetId),
      })
      .lean()
      .select('_id');

    if (exists) throw new ConflictException('Vous avez déjà soumis un avis pour cet élément.');

    const review = await this.reviewModel.create({
      ...dto,
      author: new Types.ObjectId(authorId),
      targetId: new Types.ObjectId(dto.targetId),
    });
    return review.toObject();
  }

  async findForTarget(
    targetType: string,
    targetId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResult<Review>> {
    const skip = (page - 1) * limit;
    const filter = { targetType, targetId: new Types.ObjectId(targetId) };

    const [data, total] = await Promise.all([
      this.reviewModel
        .find(filter)
        .skip(skip)
        .limit(limit)
        .populate('author', 'fullName')
        .lean()
        .select('-__v'),
      this.reviewModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  async remove(id: string, authorId: string): Promise<void> {
    const review = await this.reviewModel.findOne({ _id: id, author: new Types.ObjectId(authorId) });
    if (!review) throw new NotFoundException('Avis introuvable ou accès refusé.');
    await review.deleteOne();
  }
}
