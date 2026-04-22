import { IsEnum, IsString } from 'class-validator';
import { FavoriteTargetType } from '../favorite.schema';

export class CreateFavoriteDto {
  @IsEnum(FavoriteTargetType)
  targetType!: FavoriteTargetType;

  @IsString()
  targetId!: string;
}
