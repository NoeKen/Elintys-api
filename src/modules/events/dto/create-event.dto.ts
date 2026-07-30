import {
  IsDateString,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EventLocationType,
  EventType,
  EventVisibility,
  ProviderSelectionMode,
  VenueMode,
} from '../event.schema';

export class LocationDto {
  @ApiProperty({ enum: EventLocationType, example: EventLocationType.PHYSICAL, description: 'Type de lieu' })
  @IsEnum(EventLocationType)
  type!: EventLocationType;

  @ApiPropertyOptional({ example: 'Le Belvédère', maxLength: 200 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  name?: string;

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

  @ApiPropertyOptional({ example: 'Québec', maxLength: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  province?: string;

  @ApiPropertyOptional({ example: 'H2X 1Y4', maxLength: 20 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @ApiPropertyOptional({ example: 'contact@lieu.ca' })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional({ example: 'https://meet.google.com/abc-defg-hij', description: 'URL pour événement en ligne' })
  @IsOptional()
  @IsUrl()
  onlineUrl?: string;
}

export class ProviderNeedDto {
  @IsString()
  @MaxLength(50)
  @Transform(({ value }: { value: string }) => value?.trim())
  category!: string;

  @IsEnum(ProviderSelectionMode)
  mode!: ProviderSelectionMode;
}

export class EventAccessRulesDto {
  @IsOptional()
  @IsBoolean()
  privateLink?: boolean;

  @IsOptional()
  @IsBoolean()
  accessCode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^@?[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  allowedEmailDomain?: string;

  @IsOptional()
  @IsBoolean()
  manualApproval?: boolean;
}

export class EventCreationProgressDto {
  @IsInt()
  @Min(1)
  @Max(6)
  currentStep!: number;

  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(6, { each: true })
  completedSteps!: number[];

  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(6, { each: true })
  skippedSteps!: number[];
}

export class CreateEventDto {
  @ApiProperty({ example: 'Gala de printemps 2025', description: 'Titre de l\'événement', maxLength: 200 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(500)
  shortDescription?: string;

  @ApiPropertyOptional({ example: 'Un événement exceptionnel réunissant les leaders du secteur.', maxLength: 5000 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '2025-06-15T18:00:00.000Z', description: 'Date et heure de début (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2025-06-15T23:00:00.000Z', description: 'Date et heure de fin (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ type: () => LocationDto, description: 'Lieu de l\'événement' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  @ApiPropertyOptional({ example: 'America/Toronto' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/)
  timezone?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dateIsTentative?: boolean;

  @ApiPropertyOptional({ enum: VenueMode })
  @IsOptional()
  @IsEnum(VenueMode)
  venueMode?: VenueMode;

  @ApiPropertyOptional({ description: 'ID du profil de lieu sélectionné' })
  @IsOptional()
  @IsMongoId()
  venueProfile?: string;

  @ApiPropertyOptional({ enum: EventVisibility, example: EventVisibility.PUBLIC, default: EventVisibility.PUBLIC })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional({ type: () => EventAccessRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventAccessRulesDto)
  accessRules?: EventAccessRulesDto;

  @ApiPropertyOptional({ example: 200, description: 'Capacité maximale (0 = illimitée)', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  capacity?: number;

  @ApiPropertyOptional({ type: [ProviderNeedDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ProviderNeedDto)
  providerNeeds?: ProviderNeedDto[];

  @ApiPropertyOptional({ type: () => EventCreationProgressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EventCreationProgressDto)
  creationProgress?: EventCreationProgressDto;
}
