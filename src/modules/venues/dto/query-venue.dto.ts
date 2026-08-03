import { Transform, Type } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { VenueType } from '../venue.schema';

export class QueryVenueDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: VenueType })
  @IsOptional()
  @IsEnum(VenueType)
  type?: VenueType;

  @ApiPropertyOptional({ example: 'Montréal' })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    example: 200,
    minimum: 1,
    description: 'Capacité minimale requise',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity?: number;
}
