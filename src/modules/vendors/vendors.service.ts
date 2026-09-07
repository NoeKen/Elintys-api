import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { VendorProfile, VendorProfileDocument, VendorRequest, VendorRequestDocument, VendorRequestSource, VendorRequestStatus } from './vendor.schema';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { QueryVendorDto, VendorPriceTier } from './dto/query-vendor.dto';
import { CreateVendorRequestDto } from './dto/create-request.dto';
import { RespondVendorRequestDto } from './dto/respond-request.dto';
import { isDuplicateKeyError } from '../../shared/utils/mongo-errors';
import { canManageEvent } from '../events/event-access.policy';
import { PaginatedResult } from '../../shared/interfaces/paginated-result.interface';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification.schema';
import { EmailsService } from '../emails/emails.service';
import { User, UserDocument } from '../auth/user.schema';
import { Event, EventDocument } from '../events/event.schema';
import { escapeRegExp } from '../../shared/utils/escape-regexp';

/**
 * Projection des routes PUBLIQUES.
 *
 * `select('-__v')` renvoyait tout le document, dont `user` — l'identifiant
 * interne du compte propriétaire — sur un catalogue anonyme. Les endpoints
 * `/discovery/vendors` appliquaient déjà une projection propre : les deux
 * surfaces sont désormais alignées.
 *
 * `contactEmail` reste exposé : c'est la raison d'être d'un annuaire de
 * prestataires, et la fiche publique l'affiche.
 */
const PUBLIC_VENDOR_FIELDS =
  '_id businessName category description photos priceRange serviceArea contactEmail rating reviewCount isActive isPremium';

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
    if (exists) throw new ConflictException(ErrorCodes.VENDOR_PROFILE_EXISTS);

    try {
      const vendor = await this.vendorModel.create({ ...dto, user: new Types.ObjectId(userId) });
      return vendor.toObject();
    } catch (error) {
      // L'index unique sur `user` est l'autorité : deux créations concurrentes
      // (double soumission du formulaire) donnent un conflit métier, pas une 500.
      if (isDuplicateKeyError(error)) throw new ConflictException(ErrorCodes.VENDOR_PROFILE_EXISTS);
      throw error;
    }
  }

  /**
   * Mise à jour du profil du prestataire CONNECTÉ.
   *
   * L'identité vient de `userId` (issu du JWT), jamais d'un identifiant fourni
   * par le client : il n'y a donc aucune surface d'IDOR sur cette route.
   */
  async updateMyProfile(userId: string, dto: UpdateVendorDto): Promise<VendorProfile> {
    const updated = await this.vendorModel
      .findOneAndUpdate({ user: new Types.ObjectId(userId) }, dto, { new: true, runValidators: true })
      .lean()
      .select('-__v');
    if (!updated) throw new NotFoundException(ErrorCodes.VENDOR_PROFILE_NOT_FOUND);
    return updated;
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
      this.vendorModel
        .find(filter)
        .skip(skip)
        .limit(limit)
        .sort({ rating: -1 })
        .lean()
        .select(PUBLIC_VENDOR_FIELDS),
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
    const vendor = await this.vendorModel
      .findOne({ _id: id, isActive: true })
      .lean()
      .select(PUBLIC_VENDOR_FIELDS);
    if (!vendor) throw new NotFoundException(ErrorCodes.VENDOR_NOT_FOUND);
    return vendor;
  }

  async findMyProfile(userId: string): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('-__v');
    // 404 métier explicite : le client bascule en mode création, il ne doit
    // jamais afficher un formulaire d'édition vide comme si un profil existait.
    if (!vendor) throw new NotFoundException(ErrorCodes.VENDOR_PROFILE_NOT_FOUND);
    return vendor;
  }

  async update(id: string, userId: string, dto: UpdateVendorDto): Promise<VendorProfile> {
    const vendor = await this.vendorModel.findById(id).lean().select('user');
    if (!vendor) throw new NotFoundException(ErrorCodes.VENDOR_NOT_FOUND);
    if (vendor.user.toString() !== userId) throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);

    const updated = await this.vendorModel.findByIdAndUpdate(id, dto, { new: true }).lean().select('-__v');
    // Peut être null si le profil a été supprimé entre la vérification et l'écriture.
    if (!updated) throw new NotFoundException(ErrorCodes.VENDOR_NOT_FOUND);
    return updated;
  }

  // ── VendorRequest methods ──

  async createRequest(eventId: string, organizerId: string, dto: CreateVendorRequestDto, roles: string[] = []): Promise<VendorRequest> {
    const event = await this.eventModel
      .findById(eventId)
      .lean()
      .select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId: organizerId, roles }, event as never).allowed) {
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

    this.announceNewRequest(String(req._id), eventId, organizerId, dto).catch(() => undefined);

    return req.toObject();
  }

  /**
   * Prévient le prestataire qu'une demande l'attend.
   *
   * Best-effort : jamais attendu par `createRequest`, pour qu'une panne de
   * Resend ou de la messagerie interne n'empêche pas la création de la demande.
   * Un contact externe n'a pas de compte Elintys — il reçoit donc le courriel
   * mais aucune notification in-app.
   */
  private async announceNewRequest(
    requestId: string,
    eventId: string,
    organizerId: string,
    dto: CreateVendorRequestDto,
  ): Promise<void> {
    const [organizer, event] = await Promise.all([
      this.userModel.findById(organizerId).lean().select('fullName'),
      this.eventModel.findById(eventId).lean().select('title'),
    ]);
    if (!organizer || !event) return;

    const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');
    const requestsPath = '/tableau-de-bord/prestataire/demandes';

    if (!dto.vendorId) {
      const email = dto.externalContact?.email;
      if (!email) return;
      await this.emailsService.sendNewRequest(email, {
        organizerName: organizer.fullName,
        vendorName: dto.externalContact?.name ?? '',
        eventTitle: event.title,
        requestUrl: `${frontendUrl}/inscription?redirect=${encodeURIComponent(requestsPath)}`,
      });
      return;
    }

    const vendor = await this.vendorModel.findById(dto.vendorId).lean().select('user businessName');
    if (!vendor) return;
    const vendorUserId = vendor.user.toString();

    await this.notificationsService
      .create(vendorUserId, NotificationType.VENDOR_REQUEST_RECEIVED, {
        requestId,
        eventId,
        eventTitle: event.title,
        organizerName: organizer.fullName,
      })
      .catch(() => undefined);

    const vendorUser = await this.userModel.findById(vendorUserId).lean().select('email');
    if (!vendorUser?.email) return;

    await this.emailsService.sendNewRequest(vendorUser.email, {
      organizerName: organizer.fullName,
      vendorName: vendor.businessName,
      eventTitle: event.title,
      requestUrl: `${frontendUrl}${requestsPath}`,
    });
  }

  async listRequestsByEvent(eventId: string, organizerId: string, roles: string[] = []): Promise<VendorRequest[]> {
    const event = await this.eventModel
      .findById(eventId)
      .lean()
      .select('organizer');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (!canManageEvent({ userId: organizerId, roles }, event as never).allowed) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }

    return this.vendorRequestModel
      .find({ event: new Types.ObjectId(eventId) })
      .populate('vendor', 'businessName category')
      .lean()
      .select('-__v');
  }

  /**
   * Réponse du prestataire à une demande.
   *
   * La transition est ATOMIQUE : le filtre du `findOneAndUpdate` porte à la
   * fois l'identité de la demande, la propriété (`vendor`) et l'état attendu
   * (`PENDING`). Deux réponses concurrentes (ex. « accepter » et « refuser »
   * envoyés en même temps) ne peuvent donc pas réussir toutes les deux : la
   * seconde ne matche plus `status: PENDING` et reçoit un conflit.
   *
   * Corollaire indispensable : les effets de bord (notification, e-mail) ne
   * sont déclenchés QUE pour la transition gagnante. Avant ce correctif,
   * l'organisateur pouvait recevoir une notification « accepté » ET une
   * notification « refusé » pour la même demande.
   */
  async respondToRequest(requestId: string, userId: string, dto: RespondVendorRequestDto): Promise<VendorRequest> {
    const vendorProfile = await this.vendorModel
      .findOne({ user: new Types.ObjectId(userId) })
      .lean()
      .select('_id businessName');
    if (!vendorProfile) throw new NotFoundException(ErrorCodes.VENDOR_PROFILE_NOT_FOUND);

    const updated = await this.vendorRequestModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(requestId),
          vendor: vendorProfile._id,
          status: VendorRequestStatus.PENDING,
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

    // Aucune ligne mise à jour : on relit pour distinguer les causes possibles
    // sans jamais révéler l'existence d'une demande appartenant à autrui.
    if (!updated) {
      throw await this.failedRequestTransitionError(requestId, vendorProfile._id as Types.ObjectId);
    }

    const organizerId = (updated.organizer as Types.ObjectId).toString();

    this.notificationsService
      .create(organizerId, NotificationType.VENDOR_RESPONDED, { requestId, status: dto.status })
      .catch(() => undefined);

    if (dto.status === VendorRequestStatus.ACCEPTED) {
      const frontendUrl = this.configService.getOrThrow<string>('frontendUrl');
      Promise.all([
        this.userModel.findById(organizerId).lean().select('email fullName'),
        this.eventModel.findById((updated.event as Types.ObjectId).toString()).lean().select('title'),
      ]).then(([organizer, event]) => {
        if (!organizer || !event) return;
        return this.emailsService.sendRequestAccepted(organizer.email, {
          vendorName: vendorProfile.businessName,
          organizerName: organizer.fullName,
          eventTitle: event.title,
          eventUrl: `${frontendUrl}/tableau-de-bord/evenements`,
        });
      }).catch(() => undefined);
    }

    return updated;
  }

  /**
   * Traduit l'échec d'une transition conditionnelle en erreur métier précise.
   *
   * Renvoie l'exception au lieu de la lever : l'appelant écrit `throw await …`,
   * ce qui permet à TypeScript de restreindre le type sans assertion `!`.
   */
  private async failedRequestTransitionError(
    requestId: string,
    vendorProfileId: Types.ObjectId,
  ): Promise<HttpException> {
    const current = await this.vendorRequestModel
      .findById(requestId)
      .lean()
      .select('vendor status');

    if (!current) return new NotFoundException(ErrorCodes.REQUEST_NOT_FOUND);
    if (!current.vendor) return new BadRequestException(ErrorCodes.MANUAL_REQUEST_NO_PLATFORM_VENDOR);
    if (current.vendor.toString() !== vendorProfileId.toString()) {
      return new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }
    // La demande nous appartient mais n'est plus PENDING : elle a déjà été
    // tranchée (ou annulée) entre notre lecture et notre écriture.
    return new ConflictException(ErrorCodes.INVALID_STATUS_TRANSITION);
  }

  async listMyRequests(userId: string): Promise<VendorRequest[]> {
    const vendorProfile = await this.vendorModel.findOne({ user: new Types.ObjectId(userId) }).lean().select('_id');
    if (!vendorProfile) throw new NotFoundException(ErrorCodes.VENDOR_PROFILE_NOT_FOUND);

    return this.vendorRequestModel
      .find({ vendor: vendorProfile._id })
      .populate('event', 'title startDate slug')
      // `organizer` doit être peuplé : sans cela l'écran prestataire affiche
      // un nom vide en lisant `.fullName` sur un ObjectId.
      .populate('organizer', 'fullName')
      .sort({ createdAt: -1 })
      .lean()
      .select('-__v');
  }

  /**
   * Annulation par l'organisateur.
   *
   * Suppression conditionnelle atomique : la course « annuler pendant que le
   * prestataire répond » a exactement un gagnant. Si l'annulation perd, la
   * demande n'est plus PENDING et l'appelant reçoit un conflit stable.
   */
  async cancelRequest(requestId: string, organizerId: string, roles: string[] = []): Promise<void> {
    // Un admin peut annuler la demande de n'importe quel organisateur : le
    // filtre ne restreint donc l'organisateur que pour un non-admin.
    const isAdmin = roles.includes('admin');
    const deleted = await this.vendorRequestModel
      .findOneAndDelete({
        _id: new Types.ObjectId(requestId),
        ...(isAdmin ? {} : { organizer: new Types.ObjectId(organizerId) }),
        status: VendorRequestStatus.PENDING,
      })
      .lean()
      .select('_id');

    if (deleted) return;

    const current = await this.vendorRequestModel
      .findById(requestId)
      .lean()
      .select('organizer status');
    if (!current) throw new NotFoundException(ErrorCodes.REQUEST_NOT_FOUND);
    if (!isAdmin && current.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }
    throw new ConflictException(ErrorCodes.INVALID_STATUS_TRANSITION);
  }
}
