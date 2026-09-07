import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Favorite, FavoriteDocument, FavoriteTargetType } from './favorite.schema';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { FavoriteTargetView, FavoriteView } from './favorite-view';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { isDuplicateKeyError } from '../../shared/utils/mongo-errors';
import { Event, EventDocument } from '../events/event.schema';
import { VendorProfile, VendorProfileDocument } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileDocument } from '../venues/venue.schema';

function firstPhoto(photos: string[] | undefined): string | undefined {
  return photos && photos.length > 0 ? photos[0] : undefined;
}

function coverUrl(cover: unknown): string | undefined {
  if (typeof cover === 'string') return cover || undefined;
  if (cover && typeof cover === 'object' && typeof (cover as { url?: unknown }).url === 'string') {
    return (cover as { url: string }).url;
  }
  return undefined;
}

@Injectable()
export class FavoritesService {
  constructor(
    @InjectModel(Favorite.name) private readonly favoriteModel: Model<FavoriteDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
  ) {}

  /**
   * La cible doit exister avant d'être mise en favori : sans cette vérification
   * l'utilisateur peut accumuler des favoris orphelins qui n'afficheront jamais
   * rien, et l'API accepterait n'importe quel ObjectId bien formé.
   */
  private async targetExists(targetType: FavoriteTargetType, targetId: Types.ObjectId): Promise<boolean> {
    switch (targetType) {
      case FavoriteTargetType.EVENT:
        return (await this.eventModel.exists({ _id: targetId })) !== null;
      case FavoriteTargetType.VENDOR:
        return (await this.vendorModel.exists({ _id: targetId })) !== null;
      case FavoriteTargetType.VENUE:
        return (await this.venueModel.exists({ _id: targetId })) !== null;
    }
  }

  async add(userId: string, dto: CreateFavoriteDto): Promise<Favorite> {
    const targetId = new Types.ObjectId(dto.targetId);

    if (!(await this.targetExists(dto.targetType, targetId))) {
      throw new NotFoundException(ErrorCodes.FAVORITE_TARGET_NOT_FOUND);
    }

    try {
      const fav = await this.favoriteModel.create({
        user: new Types.ObjectId(userId),
        targetType: dto.targetType,
        targetId,
      });
      return fav.toObject();
    } catch (error) {
      // L'index unique {user, targetType, targetId} est l'autorité : deux clics
      // concurrents ne peuvent pas créer deux favoris. On traduit la violation
      // en conflit métier au lieu de laisser remonter une 500.
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(ErrorCodes.FAVORITE_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  /**
   * Liste enrichie.
   *
   * L'enrichissement est groupé par type : au plus trois requêtes
   * supplémentaires quel que soit le nombre de favoris. Aucun N+1.
   */
  async findMyFavorites(userId: string, targetType?: FavoriteTargetType): Promise<FavoriteView[]> {
    const filter: Record<string, unknown> = { user: new Types.ObjectId(userId) };
    if (targetType) filter['targetType'] = targetType;

    const favorites = await this.favoriteModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .select('_id targetType targetId createdAt');

    if (favorites.length === 0) return [];

    const idsByType = new Map<FavoriteTargetType, Types.ObjectId[]>();
    for (const favorite of favorites) {
      const bucket = idsByType.get(favorite.targetType) ?? [];
      bucket.push(favorite.targetId);
      idsByType.set(favorite.targetType, bucket);
    }

    const targets = new Map<string, FavoriteTargetView>();

    const eventIds = idsByType.get(FavoriteTargetType.EVENT);
    if (eventIds?.length) {
      const events = await this.eventModel
        .find({ _id: { $in: eventIds } })
        .lean()
        .select('_id title slug startDate coverImage location.city');
      for (const event of events) {
        const id = (event._id as Types.ObjectId).toString();
        targets.set(`${FavoriteTargetType.EVENT}:${id}`, {
          _id: id,
          label: event.title,
          // Pas de slug ⇒ pas de page publique : on n'invente pas de lien mort.
          href: event.slug ? `/evenements/${event.slug}` : undefined,
          imageUrl: coverUrl(event.coverImage),
          subtitle: event.location?.city,
          startDate: event.startDate ? new Date(event.startDate).toISOString() : undefined,
        });
      }
    }

    const vendorIds = idsByType.get(FavoriteTargetType.VENDOR);
    if (vendorIds?.length) {
      const vendors = await this.vendorModel
        .find({ _id: { $in: vendorIds } })
        .lean()
        .select('_id businessName category photos serviceArea');
      for (const vendor of vendors) {
        const id = (vendor._id as Types.ObjectId).toString();
        targets.set(`${FavoriteTargetType.VENDOR}:${id}`, {
          _id: id,
          label: vendor.businessName,
          href: `/prestataires/${id}`,
          imageUrl: firstPhoto(vendor.photos),
          subtitle: vendor.serviceArea,
        });
      }
    }

    const venueIds = idsByType.get(FavoriteTargetType.VENUE);
    if (venueIds?.length) {
      const venues = await this.venueModel
        .find({ _id: { $in: venueIds } })
        .lean()
        .select('_id name photos address.city');
      for (const venue of venues) {
        const id = (venue._id as Types.ObjectId).toString();
        targets.set(`${FavoriteTargetType.VENUE}:${id}`, {
          _id: id,
          label: venue.name,
          href: `/lieux/${id}`,
          imageUrl: firstPhoto(venue.photos),
          subtitle: venue.address?.city,
        });
      }
    }

    return favorites.map((favorite) => {
      const targetId = favorite.targetId.toString();
      return {
        _id: (favorite._id as Types.ObjectId).toString(),
        targetType: favorite.targetType,
        targetId,
        createdAt:
          'createdAt' in favorite && favorite.createdAt
            ? new Date(favorite.createdAt as Date).toISOString()
            : undefined,
        // `null` explicite : la cible a été supprimée depuis la mise en favori.
        target: targets.get(`${favorite.targetType}:${targetId}`) ?? null,
      };
    });
  }

  async remove(userId: string, dto: CreateFavoriteDto): Promise<void> {
    const result = await this.favoriteModel.findOneAndDelete({
      user: new Types.ObjectId(userId),
      targetType: dto.targetType,
      targetId: new Types.ObjectId(dto.targetId),
    });
    if (!result) throw new NotFoundException(ErrorCodes.FAVORITE_NOT_FOUND);
  }
}
