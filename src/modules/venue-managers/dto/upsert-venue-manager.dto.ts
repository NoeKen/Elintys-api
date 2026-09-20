import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { trimLowerValue, trimValue } from '../../../shared/utils/transform';

export class UpsertVenueManagerDto {
  @ApiProperty({ maxLength: 200 })
  @Transform(trimValue)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  professionalName!: string;

  @ApiPropertyOptional({ maxLength: 3000 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(3000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(150)
  region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimLowerValue)
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(30)
  contactPhone?: string;
}
