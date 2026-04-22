import { IsEnum, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ReviewTargetType } from '../review.schema';

export class CreateReviewDto {
  @IsEnum(ReviewTargetType)
  targetType!: ReviewTargetType;

  @IsString()
  targetId!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(2000)
  comment!: string;
}
