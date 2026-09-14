import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { trimValue } from '../../../shared/utils/transform';
import { VendorCategory } from '../../vendors/vendor.schema';
import { VendorPriceTier } from '../../vendors/dto/query-vendor.dto';
import { EventType } from '../../events/event.schema';
import { VenueType } from '../../venues/venue.schema';

/**
 * Bornes de pagination des surfaces publiques.
 *
 * Sans plafond, `?limit=100000` produit une requête non bornée sur une route
 * anonyme : coût serveur arbitraire pour un attaquant à coût nul. Sans
 * plancher, `?page=-5` produit un `skip` négatif que Mongo rejette — une
 * erreur 500 pour une simple valeur invalide.
 */
export const DISCOVERY_MAX_LIMIT = 50;
/** Évite les `skip` Mongo arbitrairement grands sur les routes anonymes. */
export const DISCOVERY_MAX_PAGE = 10_000;

/** Longueur maximale d'un terme de recherche, avant échappement. */
export const DISCOVERY_MAX_QUERY_LENGTH = 120;

export enum DiscoveryEntityType {
  ALL = 'all',
  EVENT = 'event',
  VENDOR = 'vendor',
  VENUE = 'venue',
}

const UTC_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isUtcCalendarDate(value: unknown): value is string {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !UTC_CALENDAR_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

@ValidatorConstraint({ name: 'optionalUtcCalendarDate', async: false })
class OptionalUtcCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isUtcCalendarDate(value);
  }

  defaultMessage() {
    return 'must be a valid UTC calendar date in YYYY-MM-DD format';
  }
}

@ValidatorConstraint({ name: 'orderedDiscoveryDateRange', async: false })
class OrderedDiscoveryDateRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const input = args.object as { dateFrom?: string; dateTo?: string };
    if (!input.dateFrom || !input.dateTo) return true;
    return input.dateFrom <= input.dateTo;
  }

  defaultMessage() {
    return 'dateFrom must be before or equal to dateTo';
  }
}

class PaginatedDiscoveryQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: DISCOVERY_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: DISCOVERY_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_LIMIT)
  limit?: number = 12;
}

export class SearchDiscoveryDto extends PaginatedDiscoveryQuery {
  /**
   * Terme obligatoire : une recherche vide balayait tout le catalogue à
   * chaque appel, pour un résultat sans intérêt.
   */
  @ApiProperty({ example: 'gala montréal' })
  @Transform(trimValue)
  @IsString()
  @MinLength(2)
  @MaxLength(DISCOVERY_MAX_QUERY_LENGTH)
  q!: string;

  @ApiPropertyOptional({ enum: DiscoveryEntityType, default: DiscoveryEntityType.ALL })
  @IsOptional()
  @IsEnum(DiscoveryEntityType)
  type?: DiscoveryEntityType = DiscoveryEntityType.ALL;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: DISCOVERY_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_LIMIT)
  limit?: number = 10;
}

export class FeaturedDiscoveryDto {
  @ApiPropertyOptional({ default: 6, minimum: 1, maximum: DISCOVERY_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_LIMIT)
  limit?: number = 6;
}

export class QueryDiscoveryEventsDto extends PaginatedDiscoveryQuery {
  @ApiPropertyOptional({ maxLength: DISCOVERY_MAX_QUERY_LENGTH })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MinLength(2)
  @MaxLength(DISCOVERY_MAX_QUERY_LENGTH)
  q?: string;

  @ApiPropertyOptional({ example: 'Montréal', maxLength: 100 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  type?: EventType;

  @ApiPropertyOptional({ example: '2027-05-01', description: 'Jour UTC inclus, format YYYY-MM-DD' })
  @Validate(OptionalUtcCalendarDateConstraint)
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2027-05-31', description: 'Jour UTC inclus, format YYYY-MM-DD' })
  @Validate(OptionalUtcCalendarDateConstraint)
  @Validate(OrderedDiscoveryDateRangeConstraint)
  dateTo?: string;
}

export class QueryDiscoveryVendorsDto extends PaginatedDiscoveryQuery {
  @ApiPropertyOptional({ maxLength: DISCOVERY_MAX_QUERY_LENGTH })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MinLength(2)
  @MaxLength(DISCOVERY_MAX_QUERY_LENGTH)
  q?: string;

  /**
   * Énumération fermée : la catégorie était auparavant reprise telle quelle
   * dans le filtre Mongo, sans validation.
   */
  @ApiPropertyOptional({ enum: VendorCategory })
  @IsOptional()
  @IsEnum(VendorCategory)
  category?: VendorCategory;

  @ApiPropertyOptional({ example: 'Montréal', maxLength: 100 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ enum: VendorPriceTier })
  @IsOptional()
  @IsEnum(VendorPriceTier)
  price?: VendorPriceTier;
}

export class QueryDiscoveryVenuesDto extends PaginatedDiscoveryQuery {
  @ApiPropertyOptional({ maxLength: DISCOVERY_MAX_QUERY_LENGTH })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MinLength(2)
  @MaxLength(DISCOVERY_MAX_QUERY_LENGTH)
  q?: string;

  @ApiPropertyOptional({ example: 'Montréal', maxLength: 100 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ enum: VenueType })
  @IsOptional()
  @IsEnum(VenueType)
  type?: VenueType;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  capacity?: number;
}
