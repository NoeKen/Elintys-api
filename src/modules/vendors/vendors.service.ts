import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { VendorProfile, VendorProfileDocument, VendorRequest, VendorRequestDocument, VendorRequestSource, VendorRequestStatus } from './vendor.schema';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { QueryVendorDto, VendorPriceTier } from './dto/query-vendor.dto';
import { CreateVendorRequestDto } from './dto/create-request.dto';
import { RespondVendorRequestDto } from './dto/respond-request.dto';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification.schema';
import { EmailsService } from '../emails/emails.service';
import { User, UserDocument } from '../auth/user.schema';
import { Event, EventDocument } from '../events/event.schema';
import { escapeRegExp } from '../../shared/utils/escape-regexp';

@Injectable()
export class VendorsService {
  constructor(
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
    @InjectModel(VendorRequest.name) private readonly vendorRequestModel: Model<VendorRequestDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    private readonly notificationsService: NotificationsService,
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
  ) {}

  async create(userId: string, dto: CreateVendorDto): Promise<VendorProfile> {
    const exists = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (exists) throw new ConflictException('Un profil prestataire existe déjà pour ce compte.');

    const vendor = await this.vendorModel.create({ ...dto, user: new Types.ObjectId(userId) });
    return vendor.toObject();
  }

  async findAll(query: QueryVendorDto): Promise<PaginatedResult<VendorProfile>> {
    const { page = 1, limit = 20, category, city, price } = query;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = { isActive: true };
    if (category) filter['category'] = category;
    if (city) {
      filter.serviceArea = {
        $regex: escapeRegExp(city),
        $options: 'i',
      };
    }
    if (price) filter['priceRange.min'] = this.getPriceTierFilter(price);

    const [data, total] = await Promise.all([
      this.vendorModel.find(filter).skip(skip).limit(limit).sort({ rating: -1 }).lean().select('-__v'),
      this.vendorModel.countDocuments(filter),
    ]);

    return { data, total, page, limit };
  }

  private getPriceTierFilter(price: VendorPriceTier): Record<string, number> {
    switch (price) {
      case VendorPriceTier.BUDGET:
        return { $gte: 0, $lte: 1000 };
      case VendorPriceTier.STANDARD:
        return { $gt: 1000, $lte: 2500 };
      case VendorPriceTier.PREMIUM:
        return { $gt: 2500, $lte: 5000 };
      case VendorPriceTier.LUXURY:
        return { $gt: 5000 };
    }
  }

  async findOne(id: string): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findById(id).lean().select('-__v');
    if (!vendor) throw new NotFoundException('Profil prestataire introuvable.');
    return vendor;
  }

  async findMyProfile(userId: string): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('-__v');
    if (!vendor) throw new NotFoundException('Profil prestataire introuvable.');
    return vendor;
  }

  async update(id: string, userId: string, dto: UpdateVendorDto): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findById(id).lean().select('user');
    if (!vendor) throw new NotFoundException('Profil prestataire introuvable.');
    if (vendor.user.toString() !== userId) throw new ForbiddenException('Accès refusé.');

    const updated = await this.vendorModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    return updated!;
  }

  // ── VendorRequest methods ──

  async createRequest(eventId: string, organizerId: string, dto: CreateVendorRequestDto): Promise<VendorRequest> {
    const event = await this.eventModel
      .findById(eventId)
      .lean()
      .select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    const duplicateFilter = dto.vendorId
      ? {
          event: new Types.ObjectId(eventId),
          vendor: new Types.ObjectId(dto.vendorId),
          status: VendorRequestStatus.PENDING,
        }
      : {
          event: new Types.ObjectId(eventId),
          source: VendorRequestSource.MANUAL,
          'externalContact.name': dto.externalContact?.name,
          'externalContact.category': dto.externalContact?.category,
          status: VendorRequestStatus.PENDING,
        };
    const existingRequest = await this.vendorRequestModel
      .findOne(duplicateFilter)
      .lean()
      .select('-__v');
    if (existingRequest) return existingRequest;

    const req = await this.vendorRequestModel.create({
      event: new Types.ObjectId(eventId),
      organizer: new Types.ObjectId(organizerId),
      vendor: dto.vendorId ? new Types.ObjectId(dto.vendorId) : undefined,
      source: dto.source ?? VendorRequestSource.PLATFORM,
      message: dto.message,
      externalContact: dto.externalContact ?? null,
      status: VendorRequestStatus.PENDING,
    });
    return req.toObject();
  }

  async listRequestsByEvent(eventId: string, organizerId: string): Promise<VendorRequest[]> {
    const event = await this.eventModel
      .findById(eventId)
      .lean()
      .select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    return this.vendorRequestModel
      .find({ event: new Types.ObjectId(eventId) })
      .populate('vendor', 'businessName category')
      .lean()
      .select('-__v');
  }

  async respondToRequest(requestId: string, userId: string, dto: RespondVendorRequestDto): Promise<VendorRequest> {
    const request = await this.vendorRequestModel.findById(requestId).lean().select('vendor status organizer event');
    if (!request) throw new NotFoundException(ErrorCodes.REQUEST_NOT_FOUND);

    // State check FIRST — cannot respond to non-pending requests regardless of who you are
    if (request.status !== VendorRequestStatus.PENDING) {
      throw new BadRequestException(ErrorCodes.INVALID_STATUS_TRANSITION);
    }

    // Manual requests (no platform vendor) cannot be responded to via this endpoint
    if (!request.vendor) {
      throw new BadRequestException(ErrorCodes.MANUAL_REQUEST_NO_PLATFORM_VENDOR);
    }

    // Ownership check
    const vendorProfile = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (!vendorProfile || request.vendor.toString() !== (vendorProfile._id as Types.ObjectId).toString()) {
      throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }

    const updated = await this.vendorRequestModel
      .findByIdAndUpdate(requestId, { status: dto.status, responseMessage: dto.responseMessage, respondedAt: new Date() }, { new: true })
      .lean().select('-__v');

    const organizerId = (request.organizer as Types.ObjectId).toString();
    this.notificationsService
      .create(organizerId, NotificationType.VENDOR_RESPONDED, { requestId, status: dto.status })
      .catch(() => undefined);

    if (dto.status === VendorRequestStatus.ACCEPTED) {
      const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');
      Promise.all([
        this.userModel.findById(organizerId).lean().select('email fullName'),
        this.eventModel.findById((request.event as Types.ObjectId).toString()).lean().select('title'),
        this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('businessName'),
      ]).then(([organizer, event, vendorProfile]) => {
        if (!organizer || !event || !vendorProfile) return;
        return this.emailsService.sendRequestAccepted(organizer.email, {
          vendorName: vendorProfile.businessName,
          organizerName: organizer.fullName,
          eventTitle: event.title,
          eventUrl: `${frontendUrl}/tableau-de-bord/evenements`,
        });
      }).catch(() => undefined);
    }

    return updated!;
  }

  async listMyRequests(userId: string): Promise<VendorRequest[]> {
    const vendorProfile = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (!vendorProfile) throw new NotFoundException(ErrorCodes.VENDOR_PROFILE_NOT_FOUND);

    return this.vendorRequestModel
      .find({ vendor: vendorProfile._id })
      .populate('event', 'title startDate')
      .lean()
      .select('-__v');
  }

  async cancelRequest(requestId: string, organizerId: string): Promise<void> {
    const request = await this.vendorRequestModel.findById(requestId).lean().select('organizer status');
    if (!request) throw new NotFoundException(ErrorCodes.REQUEST_NOT_FOUND);
    if (request.organizer.toString() !== organizerId) throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    if (request.status !== VendorRequestStatus.PENDING) {
      throw new BadRequestException(ErrorCodes.INVALID_STATUS_TRANSITION);
    }
    await this.vendorRequestModel.findByIdAndDelete(requestId);
  }
}
