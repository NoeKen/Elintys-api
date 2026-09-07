import { IsEnum, IsMongoId } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FavoriteTargetType } from '../favorite.schema';

export class CreateFavoriteDto {
  @ApiProperty({ enum: FavoriteTargetType, example: FavoriteTargetType.EVENT, description: 'Type de cible' })
  @IsEnum(FavoriteTargetType)
  targetType!: FavoriteTargetType;

  /**
   * Validé comme ObjectId au niveau du DTO : un identifiant malformé produit un
   * 400 structuré, jamais un `CastError` Mongoose remonté en 500.
   */
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId de la cible' })
  @IsMongoId()
  targetId!: string;
}
