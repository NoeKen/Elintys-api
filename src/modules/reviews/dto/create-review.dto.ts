import { IsEnum, IsInt, IsMongoId, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiProperty } from '@nestjs/swagger';
import { ReviewContextType, ReviewTargetType } from '../review.schema';

export class CreateReviewDto {
  @ApiProperty({ enum: ReviewTargetType, example: ReviewTargetType.EVENT, description: 'Type de cible' })
  @IsEnum(ReviewTargetType)
  targetType!: ReviewTargetType;

  @ApiProperty({ enum: ReviewContextType, example: ReviewContextType.EVENT })
  @IsEnum(ReviewContextType)
  contextType!: ReviewContextType;

  /** La relation métier, jamais la cible, est fournie par le client. */
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'Événement, demande prestataire ou réservation vérifiable' })
  @IsMongoId()
  contextId!: string;

  @ApiProperty({ example: 5, description: 'Note de 1 à 5', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ example: 'Excellent événement, organisation impeccable!', maxLength: 2000 })
  @Transform(trimValue)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  comment!: string;
}
