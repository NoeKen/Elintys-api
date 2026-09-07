import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
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
import { QueryVenueDto } from './dto/query-venue.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification.schema';
import { EmailsService } from '../emails/emails.service';
import { User, UserDocument } from '../auth/user.schema';
import { Event, EventDocument } from '../events/event.schema';
import { isDuplicateKeyError } from '../../shared/utils/mongo-errors';
import { escapeRegExp } from '../../shared/utils/escape-regexp';
import { canManageEvent } from '../events/event-access.policy';

@Injectable()
export class VenuesService {
  constructor(
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
    @InjectModel(VenueBooking.name) private readonly venueBookingModel: Model<VenueBookingDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    private readonly notificationsService: NotificationsService,
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
  ) {}

  async create(userId: string, dto: CreateVenueDto): Promise<VenueProfile> {
    const exists = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (exists) throw new ConflictException(ErrorCodes.VENUE_PROFILE_EXISTS);

    try {
      const venue = await this.venueModel.create({ ...dto, user: new Types.ObjectId(userId) });
      return venue.toObject();
    } catch (error) {
      // L'index unique sur `user` est l'autorité en cas de double soumission.
      if (isDuplicateKeyError(error)) throw new ConflictException(ErrorCodes.VENUE_PROFILE_EXISTS);
      throw error;
    }
  }

  /**
   * Mise à jour de la fiche du gestionnaire CONNECTÉ.
   * L'identité vient du JWT : aucune autorité métier n'est acceptée du client.
   */
  async updateMyProfile(userId: string, dto: UpdateVenueDto): Promise<VenueProfile> {
    const updated = await this.venueModel
      .findOneAndUpdate({ user: new Types.ObjectId(userId) }, dto, { new: true, runValidators: true })
      .lean()
      .select('-__v');
    if (!updated) throw new NotFoundException(ErrorCodes.VENUE_PROFILE_NOT_FOUND);
    return updated;
  }

  async findAll(query: QueryVenueDto): Promise<PaginatedResult<VenueProfile>> {
    const { page = 1, limit = 20, type, city, capacity } = query;
    const skip = (page - 1) * limit;
    const filter: Record<string, unknown> = { isActive: true };
    if (type) filter.type = type;
    if (city) {
      filter['address.city'] = {
        $regex: escapeRegExp(city),
        $options: 'i',
      };
    }
    if (capacity) filter.capacity = { $gte: capacity };
    const [data, total] = await Promise.all([
      this.venueModel.find(filter).skip(skip).limit(limit).sort({ rating: -1 }).lean().select('-__v'),
      this.venueModel.countDocuments(filter),
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
    // Peut être null si la fiche a été supprimée entre la vérification et l'écriture.
    if (!updated) throw new NotFoundException(ErrorCodes.VENUE_NOT_FOUND);
    return updated;
  }

  async findMyProfile(userId: string): Promise<VenueProfile> {
    const venue = await this.venueModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('-__v');
    if (!venue) throw new NotFoundException(ErrorCodes.VENUE_PROFILE_NOT_FOUND);
    return venue;
  }

  async requestBooking(eventId: string, organizerId: string, dto: CreateVenueBookingDto, roles: string[] = []): Promise<VenueBooking> {
    const start = new Date(dto.bookingStart);
    const end = new Date(dto.bookingEnd);
    if (end <= start) throw new BadRequestException(ErrorCodes.INVALID_DATE_RANGE);

    const [event, venue] = await Promise.all([
      this.eventModel.findById(eventId).lean().select('organizer'),
      this.venueModel.findOne({ _id: dto.venueId, isActive: true }).lean().select('_id'),
    ]);
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId: organizerId, roles }, event).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
    if (!venue) throw new NotFoundException(ErrorCodes.VENUE_NOT_FOUND);

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

  async listBookingsByEvent(eventId: string, userId: string, roles: string[] = []): Promise<VenueBooking[]> {
    const event = await this.eventModel.findById(eventId).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId, roles }, event).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
    return this.venueBookingModel
      .find({ event: new Types.ObjectId(eventId) })
      .populate('venue', 'name address city')
      .lean()
      .select('-__v');
  }

  /**
   * Réponse du gestionnaire à une demande de réservation.
   *
   * Transition ATOMIQUE : identité + propriété (`venue`) + état attendu
   * (`PENDING`) sont tous dans le filtre. Deux réponses concurrentes, ou une
   * réponse concurrente d'une annulation organisateur, ont exactement un
   * gagnant.
   *
   * Corollaire indispensable : les effets de bord (notification, e-mail) ne
   * sont émis QUE pour la transition gagnante. Avant ce correctif,
   * l'organisateur pouvait recevoir « confirmé » ET « refusé » pour la même
   * réservation.
   */
  async respondToBooking(bookingId: string, userId: string, dto: RespondVenueBookingDto): Promise<VenueBooking> {
    const venueProfile = await this.venueModel
      .findOne({ user: new Types.ObjectId(userId) })
      .lean()
      .select('_id name');
    if (!venueProfile) throw new NotFoundException(ErrorCodes.VENUE_PROFILE_NOT_FOUND);

    const updated = await this.venueBookingModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(bookingId),
          venue: venueProfile._id,
          status: VenueBookingStatus.PENDING,
        },
        {
          status: dto.status,
          responseMessage: dto.responseMessage,
          respondedAt: new Date(),
        },
        { new: true },
      )
      .lean()
      .select('-__v');

    if (!updated) {
      throw await this.failedBookingTransitionError(bookingId, venueProfile._id as Types.ObjectId);
    }

    const organizerId = (updated.organizer as Types.ObjectId).toString();
    this.notificationsService
      .create(organizerId, NotificationType.VENUE_CONFIRMED, { bookingId, status: dto.status })
      .catch(() => undefined);

    const emailStatus = dto.status === VenueBookingStatus.CONFIRMED ? 'confirmed' : 'refused';
    Promise.all([
      this.userModel.findById(organizerId).lean().select('email fullName'),
      this.eventModel.findById((updated.event as Types.ObjectId).toString()).lean().select('title'),
    ]).then(([organizer, event]) => {
      if (!organizer || !event) return;
      return this.emailsService.sendVenueBookingUpdate(organizer.email, {
        fullName: organizer.fullName,
        venueName: venueProfile.name,
        eventTitle: event.title,
        status: emailStatus,
        message: dto.responseMessage,
      });
    }).catch(() => undefined);

    return updated;
  }

  /**
   * Traduit l'échec d'une transition conditionnelle en erreur métier précise.
   * Renvoie l'exception (au lieu de la lever) pour que TypeScript restreigne
   * le type de l'appelant sans assertion `!`.
   */
  private async failedBookingTransitionError(
    bookingId: string,
    venueProfileId: Types.ObjectId,
  ): Promise<HttpException> {
    const current = await this.venueBookingModel
      .findById(bookingId)
      .lean()
      .select('venue status');

    if (!current) return new NotFoundException(ErrorCodes.BOOKING_NOT_FOUND);
    if (current.venue?.toString() !== venueProfileId.toString()) {
      return new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }
    return new ConflictException(ErrorCodes.INVALID_STATUS_TRANSITION);
  }

  /**
   * Annulation par l'organisateur.
   *
   * Le filtre atomique inclut les états annulables : la course
   * « annuler pendant que le gestionnaire répond » a un seul gagnant.
   * L'autorisation événement est vérifiée AVANT la transition, car elle
   * dépend d'une autre collection et ne peut pas entrer dans le filtre.
   */
  async cancelBooking(bookingId: string, userId: string, roles: string[] = []): Promise<VenueBooking> {
    const booking = await this.venueBookingModel.findById(bookingId).lean().select('event');
    if (!booking) throw new NotFoundException(ErrorCodes.BOOKING_NOT_FOUND);

    const event = await this.eventModel.findById(booking.event.toString()).lean().select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId, roles }, event).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    const updated = await this.venueBookingModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(bookingId),
          status: { $in: [VenueBookingStatus.PENDING, VenueBookingStatus.CONFIRMED] },
        },
        { status: VenueBookingStatus.CANCELLED, respondedAt: new Date() },
        { new: true },
      )
      .lean()
      .select('-__v');

    // Perdant de la course : la réservation a changé d'état entre-temps.
    if (!updated) throw new ConflictException(ErrorCodes.INVALID_STATUS_TRANSITION);
    return updated;
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
