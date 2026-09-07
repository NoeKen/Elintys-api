import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Review, ReviewDocument, ReviewTargetType } from './review.schema';
import { CreateReviewDto } from './dto/create-review.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { isDuplicateKeyError } from '../../shared/utils/mongo-errors';
import { Event, EventDocument } from '../events/event.schema';
import { VendorProfile, VendorProfileDocument } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileDocument } from '../venues/venue.schema';

/**
 * Projection publique d'un avis.
 *
 * `select('-__v')` renvoyait le document entier. L'auteur est peuplé et réduit
 * à son nom : son identifiant de compte n'a pas à circuler sur une route
 * anonyme.
 */
const PUBLIC_REVIEW_FIELDS = '_id targetType targetId rating comment author createdAt';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review.name) private readonly reviewModel: Model<ReviewDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
  ) {}

  /**
   * La cible doit exister.
   *
   * Sans cette garde, l'API acceptait un avis sur n'importe quel ObjectId bien
   * formé : des avis orphelins s'accumulaient, invisibles et inexploitables.
   * Même raisonnement que pour les favoris (Vague A).
   */
  private async targetExists(targetType: ReviewTargetType, targetId: Types.ObjectId): Promise<boolean> {
    switch (targetType) {
      case ReviewTargetType.EVENT:
        return (await this.eventModel.exists({ _id: targetId })) !== null;
      case ReviewTargetType.VENDOR:
        return (await this.vendorModel.exists({ _id: targetId })) !== null;
      case ReviewTargetType.VENUE:
        return (await this.venueModel.exists({ _id: targetId })) !== null;
    }
  }

  async create(authorId: string, dto: CreateReviewDto): Promise<Review> {
    const targetId = new Types.ObjectId(dto.targetId);

    if (!(await this.targetExists(dto.targetType, targetId))) {
      throw new NotFoundException(ErrorCodes.REVIEW_TARGET_NOT_FOUND);
    }

    try {
      const review = await this.reviewModel.create({
        ...dto,
        author: new Types.ObjectId(authorId),
        targetId,
      });
      return review.toObject();
    } catch (error) {
      // L'index unique {author, targetType, targetId} est l'autorité : deux
      // soumissions concurrentes ne peuvent pas créer deux avis. Une
      // pré-vérification seule laissait passer la course.
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(ErrorCodes.REVIEW_ALREADY_SUBMITTED);
      }
      throw error;
    }
  }

  async findForTarget(
    targetType: ReviewTargetType,
    targetId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResult<Review>> {
    const skip = (page - 1) * limit;
    const filter = { targetType, targetId: new Types.ObjectId(targetId) };

    const [data, total] = await Promise.all([
      this.reviewModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'fullName')
        .lean()
        .select(PUBLIC_REVIEW_FIELDS),
      this.reviewModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Suppression par l'auteur.
   *
   * Le filtre combiné `{_id, author}` renvoyait « introuvable ou accès
   * refusé » : deux situations distinctes derrière un seul 404. Les avis étant
   * publics, distinguer les deux ne divulgue rien et rend l'erreur exploitable.
   */
  async remove(id: string, authorId: string): Promise<void> {
    const review = await this.reviewModel
      .findById(id)
      .lean()
      .select('author');
    if (!review) throw new NotFoundException(ErrorCodes.REVIEW_NOT_FOUND);
    if (review.author.toString() !== authorId) {
      throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }
    await this.reviewModel.findByIdAndDelete(id);
  }
}
