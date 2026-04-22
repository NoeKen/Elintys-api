import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Favorite, FavoriteDocument, FavoriteTargetType } from './favorite.schema';
import { CreateFavoriteDto } from './dto/create-favorite.dto';

@Injectable()
export class FavoritesService {
  constructor(
    @InjectModel(Favorite.name) private readonly favoriteModel: Model<FavoriteDocument>,
  ) {}

  async add(userId: string, dto: CreateFavoriteDto): Promise<Favorite> {
    const exists = await this.favoriteModel
      .findOne({
        user: new Types.ObjectId(userId),
        targetType: dto.targetType,
        targetId: new Types.ObjectId(dto.targetId),
      })
      .lean()
      .select('_id');

    if (exists) throw new ConflictException('Déjà dans vos favoris.');

    const fav = await this.favoriteModel.create({
      user: new Types.ObjectId(userId),
      targetType: dto.targetType,
      targetId: new Types.ObjectId(dto.targetId),
    });
    return fav.toObject();
  }

  async findMyFavorites(userId: string, targetType?: FavoriteTargetType): Promise<Favorite[]> {
    const filter: Record<string, unknown> = { user: new Types.ObjectId(userId) };
    if (targetType) filter['targetType'] = targetType;

    return this.favoriteModel.find(filter).lean().select('-__v');
  }

  async remove(userId: string, dto: CreateFavoriteDto): Promise<void> {
    const result = await this.favoriteModel.findOneAndDelete({
      user: new Types.ObjectId(userId),
      targetType: dto.targetType,
      targetId: new Types.ObjectId(dto.targetId),
    });
    if (!result) throw new NotFoundException('Favori introuvable.');
  }
}
