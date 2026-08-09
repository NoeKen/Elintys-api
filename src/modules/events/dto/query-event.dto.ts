import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  EventAccessPolicyType,
  EventDiscoverability,
  EventStatus,
  EventType,
  EventVisibility,
} from '../event.schema';

export enum OrganizerEventView {
  ALL = 'all',
  DRAFT = 'draft',
  READY = 'ready',
  PUBLISHED = 'published',
  COMPLETED = 'completed',
  ARCHIVED = 'archived',
}

export enum OrganizerEventSort {
  UPDATED_DESC = 'updated_desc',
  DATE_ASC = 'date_asc',
  TITLE_ASC = 'title_asc',
}

export enum OrganizerEventProgress {
  INCOMPLETE = 'incomplete',
  COMPLETE = 'complete',
}

export enum OrganizerEventDate {
  UPCOMING = 'upcoming',
  PAST = 'past',
  UNDATED = 'undated',
}

export class QueryEventDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Numéro de page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, description: 'Résultats par page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: EventStatus, description: 'Filtrer par statut' })
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @ApiPropertyOptional({ enum: EventVisibility, description: 'Filtrer par visibilité' })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional({ example: 'Montréal', description: 'Filtrer par ville' })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    enum: EventType,
    description: 'Filtrer par catégorie publique',
  })
  @IsOptional()
  @IsEnum(EventType)
  category?: EventType;

  @ApiPropertyOptional({ enum: OrganizerEventView, description: 'Vue opérationnelle organisateur' })
  @IsOptional()
  @IsEnum(OrganizerEventView)
  view?: OrganizerEventView;

  @ApiPropertyOptional({ example: 'gala Montréal', maxLength: 120 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: EventType, description: 'Type pour la bibliothèque organisateur' })
  @IsOptional()
  @IsEnum(EventType)
  eventType?: EventType;

  @ApiPropertyOptional({ enum: EventDiscoverability })
  @IsOptional()
  @IsEnum(EventDiscoverability)
  discoverability?: EventDiscoverability;

  @ApiPropertyOptional({ enum: EventAccessPolicyType })
  @IsOptional()
  @IsEnum(EventAccessPolicyType)
  accessPolicy?: EventAccessPolicyType;

  @ApiPropertyOptional({ enum: OrganizerEventProgress })
  @IsOptional()
  @IsEnum(OrganizerEventProgress)
  progress?: OrganizerEventProgress;

  @ApiPropertyOptional({ enum: OrganizerEventDate })
  @IsOptional()
  @IsEnum(OrganizerEventDate)
  date?: OrganizerEventDate;

  @ApiPropertyOptional({ enum: OrganizerEventSort, default: OrganizerEventSort.UPDATED_DESC })
  @IsOptional()
  @IsEnum(OrganizerEventSort)
  sort?: OrganizerEventSort = OrganizerEventSort.UPDATED_DESC;
}
