import { IsEnum, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FavoriteTargetType } from '../favorite.schema';

export class CreateFavoriteDto {
  @ApiProperty({ enum: FavoriteTargetType, example: FavoriteTargetType.EVENT, description: 'Type de cible' })
  @IsEnum(FavoriteTargetType)
  targetType!: FavoriteTargetType;

  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId de la cible' })
  @IsString()
  targetId!: string;
}
