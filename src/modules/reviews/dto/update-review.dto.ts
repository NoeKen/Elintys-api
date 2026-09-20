import { Transform } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { trimValue } from '../../../shared/utils/transform';

export class UpdateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @Transform(trimValue)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  comment!: string;
}
