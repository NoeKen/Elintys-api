import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  VenueBooking,
  VenueBookingDocument,
  VenueBookingStatus,
  VenueProfile,
  VenueProfileDocument,
} from './venue.schema';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { CreateVenueBookingDto } from './dto/create-booking.dto';
import { RespondVenueBookingDto } from './dto/respond-booking.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';

@Injectable()
export class VenuesService {
  constructor(
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
    @InjectModel(VenueBooking.name) private readonly venueBookingModel: Model<VenueBookingDocument>,
  ) {}

  async create(userId: string, dto: CreateVenueDto): Promise<VenueProfile> {
    const exists = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (exists) throw new ConflictException(ErrorCodes.VENUE_PROFILE_EXISTS);

    const venue = await this.venueModel.create({ ...dto, user: new Types.ObjectId(userId) });
    return venue.toObject();
  }

  async findAll(page = 1, limit = 20): Promise<PaginatedResult<VenueProfile>> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.venueModel.find({ isActive: true }).skip(skip).limit(limit).sort({ rating: -1 }).lean().select('-__v'),
      this.venueModel.countDocuments({ isActive: true }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string): Promise<VenueProfile> {
    const venue = await this.venueModel.findById(id).lean().select('-__v');
    if (!venue) throw new NotFoundException(ErrorCodes.VENUE_NOT_FOUND);
    return venue;
  }

  async update(id: string, userId: string, dto: UpdateVenueDto): Promise<VenueProfile> {
    const venue = await this.venueModel.findById(id).lean().select('user');
    if (!venue) throw new NotFoundException(ErrorCodes.VENUE_NOT_FOUND);
    if (venue.user.toString() !== userId) throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);

    const updated = await this.venueModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    return updated!;
  }

  async findMyProfile(userId: string): Promise<VenueProfile> {
    const venue = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('-__v');
    if (!venue) throw new NotFoundException(ErrorCodes.VENUE_PROFILE_NOT_FOUND);
    return venue;
  }

  async requestBooking(eventId: string, organizerId: string, dto: CreateVenueBookingDto): Promise<VenueBooking> {
    const start = new Date(dto.bookingStart);
    const end = new Date(dto.bookingEnd);
    if (end <= start) throw new BadRequestException(ErrorCodes.INVALID_DATE_RANGE);

    const booking = await this.venueBookingModel.create({
      event: new Types.ObjectId(eventId),
      organizer: new Types.ObjectId(organizerId),
      venue: new Types.ObjectId(dto.venueId),
      bookingStart: start,
      bookingEnd: end,
      message: dto.message,
      totalPrice: dto.totalPrice,
      status: VenueBookingStatus.PENDING,
    });
    return booking.toObject();
  }

  async listBookingsByEvent(eventId: string): Promise<VenueBooking[]> {
    return this.venueBookingModel
      .find({ event: new Types.ObjectId(eventId) })
      .populate('venue', 'name address city')
      .lean()
      .select('-__v');
  }

  async respondToBooking(bookingId: string, userId: string, dto: RespondVenueBookingDto): Promise<VenueBooking> {
    const booking = await this.venueBookingModel.findById(bookingId).lean().select('venue status');
    if (!booking) throw new NotFoundException(ErrorCodes.BOOKING_NOT_FOUND);

    if (booking.status !== VenueBookingStatus.PENDING) {
      throw new BadRequestException(ErrorCodes.INVALID_STATUS_TRANSITION);
    }

    const venueProfile = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (!venueProfile || booking.venue?.toString() !== (venueProfile._id as Types.ObjectId).toString()) {
      throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }

    const updated = await this.venueBookingModel
      .findByIdAndUpdate(
        bookingId,
        { status: dto.status, responseMessage: dto.responseMessage, respondedAt: new Date() },
        { new: true },
      )
      .lean()
      .select('-__v');
    return updated!;
  }

  async listMyBookings(userId: string): Promise<VenueBooking[]> {
    const venueProfile = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (!venueProfile) throw new NotFoundException(ErrorCodes.VENUE_PROFILE_NOT_FOUND);

    return this.venueBookingModel
      .find({ venue: venueProfile._id })
      .populate('event', 'title startDate')
      .lean()
      .select('-__v');
  }
}
