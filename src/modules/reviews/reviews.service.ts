import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Review, ReviewContextType, ReviewDirection, ReviewDocument, ReviewTargetType } from './review.schema';
import { CreateReviewDto } from './dto/create-review.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { isDuplicateKeyError } from '../../shared/utils/mongo-errors';
import { Event, EventDiscoverability, EventDocument, EventStatus, EventVisibility } from '../events/event.schema';
import { VendorProfile, VendorProfileDocument, VendorRequest, VendorRequestDocument, VendorRequestStatus } from '../vendors/vendor.schema';
import { VenueBooking, VenueBookingDocument, VenueBookingStatus, VenueProfile, VenueProfileDocument } from '../venues/venue.schema';
import { EventRegistration, EventRegistrationDocument, EventRegistrationStatus } from '../event-registration/event-registration.schema';
import { TicketPurchase, TicketPurchaseDocument, TicketPurchaseStatus } from '../tickets/ticket.schema';
import { VenueManagerProfile, VenueManagerProfileDocument } from '../venue-managers/venue-manager.schema';
import { UpdateReviewDto } from './dto/update-review.dto';

const PUBLIC_REVIEW_FIELDS = '_id targetType targetId rating comment author verifiedAt createdAt';
const PUBLIC_TARGETS = [ReviewTargetType.EVENT, ReviewTargetType.VENDOR, ReviewTargetType.VENUE];
type VerifiedRelation = { targetType: ReviewTargetType; targetId: Types.ObjectId; direction: ReviewDirection };
export type ReviewFeed = PaginatedResult<Review> & { summary: { average: number; count: number } };

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review.name) private readonly reviewModel: Model<ReviewDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
    @InjectModel(EventRegistration.name) private readonly registrationModel: Model<EventRegistrationDocument>,
    @InjectModel(TicketPurchase.name) private readonly ticketModel: Model<TicketPurchaseDocument>,
    @InjectModel(VendorRequest.name) private readonly vendorRequestModel: Model<VendorRequestDocument>,
    @InjectModel(VenueBooking.name) private readonly venueBookingModel: Model<VenueBookingDocument>,
    @InjectModel(VenueManagerProfile.name) private readonly venueManagerModel: Model<VenueManagerProfileDocument>,
  ) {}

  private async targetIsPubliclyVisible(targetType: ReviewTargetType, targetId: Types.ObjectId): Promise<boolean> {
    if (!PUBLIC_TARGETS.includes(targetType)) return false;
    switch (targetType) {
      case ReviewTargetType.EVENT:
        return (await this.eventModel.exists({
          _id: targetId,
          status: { $in: [EventStatus.PUBLISHED, EventStatus.COMPLETED] },
          archivedAt: null,
          $or: [
            { discoverability: { $in: [EventDiscoverability.PUBLIC, EventDiscoverability.UNLISTED] } },
            { accessModelVersion: { $exists: false }, visibility: EventVisibility.PUBLIC },
          ],
        })) !== null;
      case ReviewTargetType.VENDOR:
        return (await this.vendorModel.exists({ _id: targetId, isActive: true })) !== null;
      case ReviewTargetType.VENUE:
        return (await this.venueModel.exists({ _id: targetId, isActive: true })) !== null;
      default:
        return false;
    }
  }

  private async verifyEvent(author: Types.ObjectId, contextId: Types.ObjectId): Promise<VerifiedRelation> {
    const event = await this.eventModel.findById(contextId).lean().select('_id organizer status');
    if (!event || event.status !== EventStatus.COMPLETED || event.organizer.toString() === author.toString()) {
      throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
    }
    const [registration, ticket] = await Promise.all([
      this.registrationModel.exists({ eventId: contextId, participantId: author, status: EventRegistrationStatus.ACTIVE }),
      this.ticketModel.exists({ event: contextId, buyerId: author, status: { $in: [TicketPurchaseStatus.VALID, TicketPurchaseStatus.USED] } }),
    ]);
    if (!registration && !ticket) throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
    return { targetType: ReviewTargetType.EVENT, targetId: contextId, direction: ReviewDirection.PARTICIPANT_EVENT };
  }

  private async verifyVendor(author: Types.ObjectId, contextId: Types.ObjectId): Promise<VerifiedRelation> {
    const request = await this.vendorRequestModel.findById(contextId).lean().select('event vendor organizer status');
    if (!request?.vendor || request.status !== VendorRequestStatus.ACCEPTED) throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
    const [event, vendor] = await Promise.all([
      this.eventModel.findById(request.event).lean().select('status organizer'),
      this.vendorModel.findById(request.vendor).lean().select('_id user'),
    ]);
    if (!event || event.status !== EventStatus.COMPLETED || !vendor) throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
    if (event.organizer.toString() === author.toString()) {
      if (vendor.user.toString() === author.toString()) throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
      return { targetType: ReviewTargetType.VENDOR, targetId: vendor._id as Types.ObjectId, direction: ReviewDirection.ORGANIZER_VENDOR };
    }
    if (vendor.user.toString() === author.toString()) {
      return { targetType: ReviewTargetType.ORGANIZER, targetId: event.organizer, direction: ReviewDirection.VENDOR_ORGANIZER };
    }
    throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
  }

  private async verifyVenue(author: Types.ObjectId, contextId: Types.ObjectId): Promise<VerifiedRelation> {
    const booking = await this.venueBookingModel.findById(contextId).lean().select('event venue organizer status bookingEnd');
    if (!booking?.venue || booking.status !== VenueBookingStatus.CONFIRMED || new Date(booking.bookingEnd).getTime() > Date.now()) {
      throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
    }
    const [event, venue] = await Promise.all([
      this.eventModel.findById(booking.event).lean().select('status organizer'),
      this.venueModel.findById(booking.venue).lean().select('_id managerProfile'),
    ]);
    if (!event || event.status !== EventStatus.COMPLETED || !venue) throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
    const manager = await this.venueManagerModel.findById(venue.managerProfile).lean().select('user');
    if (event.organizer.toString() === author.toString()) {
      if (manager?.user.toString() === author.toString()) throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
      return { targetType: ReviewTargetType.VENUE, targetId: venue._id as Types.ObjectId, direction: ReviewDirection.ORGANIZER_VENUE };
    }
    if (manager?.user.toString() === author.toString()) {
      return { targetType: ReviewTargetType.ORGANIZER, targetId: event.organizer, direction: ReviewDirection.VENUE_ORGANIZER };
    }
    throw new ForbiddenException(ErrorCodes.REVIEW_NOT_ELIGIBLE);
  }

  private verifyRelation(author: Types.ObjectId, type: ReviewContextType, id: Types.ObjectId): Promise<VerifiedRelation> {
    switch (type) {
      case ReviewContextType.EVENT: return this.verifyEvent(author, id);
      case ReviewContextType.VENDOR_REQUEST: return this.verifyVendor(author, id);
      case ReviewContextType.VENUE_BOOKING: return this.verifyVenue(author, id);
    }
  }

  private async eligibilityResult(
    author: Types.ObjectId,
    relation: VerifiedRelation,
    contextType: ReviewContextType,
    contextId: Types.ObjectId,
  ) {
    const alreadyReviewed = await this.reviewModel.exists({
      schemaVersion: 2,
      author,
      contextType,
      contextId,
      direction: relation.direction,
    });
    return alreadyReviewed
      ? { canReview: false, reason: ErrorCodes.REVIEW_ALREADY_SUBMITTED }
      : { canReview: true, targetType: relation.targetType, contextType, contextId: contextId.toString() };
  }

  async eligibilityForTarget(authorId: string, targetType: ReviewTargetType, targetId: string) {
    const author = new Types.ObjectId(authorId);
    const target = new Types.ObjectId(targetId);
    try {
      if (targetType === ReviewTargetType.EVENT) {
        const relation = await this.verifyEvent(author, target);
        return this.eligibilityResult(author, relation, ReviewContextType.EVENT, target);
      }
      if (targetType === ReviewTargetType.VENDOR) {
        const vendor = await this.vendorModel.findById(target).lean().select('user');
        if (!vendor || vendor.user.toString() === authorId) {
          return { canReview: false, reason: ErrorCodes.REVIEW_NOT_ELIGIBLE };
        }
        const [request] = await this.vendorRequestModel.aggregate<{ _id: Types.ObjectId }>([
          { $match: { vendor: target, organizer: author, status: VendorRequestStatus.ACCEPTED } },
          { $lookup: {
            from: this.eventModel.collection.name,
            let: { eventId: '$event' },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$eventId'] }, status: EventStatus.COMPLETED } },
              { $project: { _id: 1 } },
            ],
            as: 'completedEvent',
          } },
          { $match: { 'completedEvent.0': { $exists: true } } },
          { $sort: { respondedAt: -1, _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ]);
        if (request) {
          const relation = { targetType, targetId: target, direction: ReviewDirection.ORGANIZER_VENDOR };
          return this.eligibilityResult(author, relation, ReviewContextType.VENDOR_REQUEST, request._id);
        }
      }
      if (targetType === ReviewTargetType.VENUE) {
        const venue = await this.venueModel.findById(target).lean().select('managerProfile');
        if (!venue) return { canReview: false, reason: ErrorCodes.REVIEW_NOT_ELIGIBLE };
        const manager = await this.venueManagerModel.findById(venue.managerProfile).lean().select('user');
        if (manager?.user.toString() === authorId) {
          return { canReview: false, reason: ErrorCodes.REVIEW_NOT_ELIGIBLE };
        }
        const [booking] = await this.venueBookingModel.aggregate<{ _id: Types.ObjectId }>([
          { $match: {
            venue: target,
            organizer: author,
            status: VenueBookingStatus.CONFIRMED,
            bookingEnd: { $lte: new Date() },
          } },
          { $lookup: {
            from: this.eventModel.collection.name,
            let: { eventId: '$event' },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$eventId'] }, status: EventStatus.COMPLETED } },
              { $project: { _id: 1 } },
            ],
            as: 'completedEvent',
          } },
          { $match: { 'completedEvent.0': { $exists: true } } },
          { $sort: { bookingEnd: -1, _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ]);
        if (booking) {
          const relation = { targetType, targetId: target, direction: ReviewDirection.ORGANIZER_VENUE };
          return this.eligibilityResult(author, relation, ReviewContextType.VENUE_BOOKING, booking._id);
        }
      }
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
    }
    return { canReview: false, reason: ErrorCodes.REVIEW_NOT_ELIGIBLE };
  }

  async eligibilityForContext(authorId: string, contextType: ReviewContextType, contextId: string) {
    const author = new Types.ObjectId(authorId);
    const context = new Types.ObjectId(contextId);
    try {
      const relation = await this.verifyRelation(author, contextType, context);
      return this.eligibilityResult(author, relation, contextType, context);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      return { canReview: false, reason: ErrorCodes.REVIEW_NOT_ELIGIBLE };
    }
  }

  async create(authorId: string, dto: CreateReviewDto): Promise<Review> {
    const author = new Types.ObjectId(authorId);
    const contextId = new Types.ObjectId(dto.contextId);
    const verified = await this.verifyRelation(author, dto.contextType, contextId);
    if (verified.targetType !== dto.targetType) throw new ConflictException(ErrorCodes.REVIEW_DIRECTION_MISMATCH);
    try {
      const review = await this.reviewModel.create({
        schemaVersion: 2, author, contextType: dto.contextType, contextId,
        targetType: verified.targetType, targetId: verified.targetId, direction: verified.direction,
        rating: dto.rating, comment: dto.comment, verifiedAt: new Date(),
      });
      return review.toObject();
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictException(ErrorCodes.REVIEW_ALREADY_SUBMITTED);
      throw error;
    }
  }

  private async feed(filter: Record<string, unknown>, page: number, limit: number): Promise<ReviewFeed> {
    const [data, total, aggregate] = await Promise.all([
      this.reviewModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('author', 'fullName -_id').lean().select(PUBLIC_REVIEW_FIELDS),
      this.reviewModel.countDocuments(filter),
      this.reviewModel.aggregate([{ $match: filter }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]),
    ]);
    return { data, total, page, limit, summary: { average: aggregate[0]?.average ?? 0, count: aggregate[0]?.count ?? 0 } };
  }

  async findForTarget(targetType: ReviewTargetType, targetId: string, page = 1, limit = 20): Promise<ReviewFeed> {
    const objectId = new Types.ObjectId(targetId);
    if (!(await this.targetIsPubliclyVisible(targetType, objectId))) throw new NotFoundException(ErrorCodes.REVIEW_TARGET_NOT_FOUND);
    return this.feed({ schemaVersion: 2, targetType, targetId: objectId }, page, limit);
  }

  findOrganizerReceived(userId: string, page = 1, limit = 20): Promise<ReviewFeed> {
    return this.feed({ schemaVersion: 2, targetType: ReviewTargetType.ORGANIZER, targetId: new Types.ObjectId(userId) }, page, limit);
  }

  async update(id: string, authorId: string, dto: UpdateReviewDto): Promise<Review> {
    const review = await this.reviewModel.findById(id).lean().select('author');
    if (!review) throw new NotFoundException(ErrorCodes.REVIEW_NOT_FOUND);
    if (review.author.toString() !== authorId) throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    const updated = await this.reviewModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), author: new Types.ObjectId(authorId), schemaVersion: 2 },
      { rating: dto.rating, comment: dto.comment },
      { new: true, runValidators: true },
    ).lean().select(PUBLIC_REVIEW_FIELDS);
    if (!updated) throw new NotFoundException(ErrorCodes.REVIEW_NOT_FOUND);
    return updated;
  }

  async remove(id: string, authorId: string): Promise<void> {
    const review = await this.reviewModel.findById(id).lean().select('author');
    if (!review) throw new NotFoundException(ErrorCodes.REVIEW_NOT_FOUND);
    if (review.author.toString() !== authorId) throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    await this.reviewModel.findByIdAndDelete(id);
  }
}
