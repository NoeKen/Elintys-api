import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EventLocationType, EventVisibility } from '../event.schema';

export class LocationDto {
  @ApiProperty({ enum: EventLocationType, example: EventLocationType.PHYSICAL, description: 'Type de lieu' })
  @IsEnum(EventLocationType)
  type!: EventLocationType;

  @ApiPropertyOptional({ example: '1234 Rue Sainte-Catherine, Montréal, QC', maxLength: 300 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: 'Montréal', maxLength: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'https://meet.google.com/abc-defg-hij', description: 'URL pour événement en ligne' })
  @IsOptional()
  @IsUrl()
  onlineUrl?: string;
}

export class CreateEventDto {
  @ApiProperty({ example: 'Gala de printemps 2025', description: 'Titre de l\'événement', maxLength: 200 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'Un événement exceptionnel réunissant les leaders du secteur.', maxLength: 5000 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({ example: '2025-06-15T18:00:00.000Z', description: 'Date et heure de début (ISO 8601)' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ example: '2025-06-15T23:00:00.000Z', description: 'Date et heure de fin (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ type: () => LocationDto, description: 'Lieu de l\'événement' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  @ApiPropertyOptional({ enum: EventVisibility, example: EventVisibility.PUBLIC, default: EventVisibility.PUBLIC })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional({ example: 200, description: 'Capacité maximale (0 = illimitée)', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  capacity?: number;
}
