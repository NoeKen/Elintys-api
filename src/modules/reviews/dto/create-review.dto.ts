import { IsEnum, IsInt, IsMongoId, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiProperty } from '@nestjs/swagger';
import { ReviewTargetType } from '../review.schema';

export class CreateReviewDto {
  @ApiProperty({ enum: ReviewTargetType, example: ReviewTargetType.EVENT, description: 'Type de cible' })
  @IsEnum(ReviewTargetType)
  targetType!: ReviewTargetType;

  /** Validé comme ObjectId : un identifiant malformé produit un 400, pas un CastError en 500. */
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId de la cible' })
  @IsMongoId()
  targetId!: string;

  @ApiProperty({ example: 5, description: 'Note de 1 à 5', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ example: 'Excellent événement, organisation impeccable!', maxLength: 2000 })
  @Transform(trimValue)
  @IsString()
  @MaxLength(2000)
  comment!: string;
}
