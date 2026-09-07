import { IsEnum, IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReviewTargetType } from '../review.schema';

/** Même plafond que Discovery : ces routes sont publiques et anonymes. */
export const REVIEWS_MAX_LIMIT = 50;

export class ReviewTargetParamsDto {
  /**
   * Énumération fermée. `targetType` était repris tel quel dans le filtre :
   * `/reviews/hacker/<id>` répondait 200 avec une liste vide, ce qui présente
   * une valeur invalide comme un résultat légitime.
   */
  @ApiProperty({ enum: ReviewTargetType })
  @IsEnum(ReviewTargetType)
  targetType!: ReviewTargetType;

  /**
   * Déclaré ici aussi : avec `forbidNonWhitelisted`, un paramètre de route
   * absent du DTO est REJETÉ. Valider `targetType` seul cassait les appels
   * légitimes.
   */
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d' })
  @IsMongoId()
  targetId!: string;
}

export class QueryReviewsDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: REVIEWS_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REVIEWS_MAX_LIMIT)
  limit?: number = 20;
}
