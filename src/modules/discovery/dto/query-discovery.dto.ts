import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { trimValue } from '../../../shared/utils/transform';
import { VendorCategory } from '../../vendors/vendor.schema';

/**
 * Bornes de pagination des surfaces publiques.
 *
 * Sans plafond, `?limit=100000` produit une requête non bornée sur une route
 * anonyme : coût serveur arbitraire pour un attaquant à coût nul. Sans
 * plancher, `?page=-5` produit un `skip` négatif que Mongo rejette — une
 * erreur 500 pour une simple valeur invalide.
 */
export const DISCOVERY_MAX_LIMIT = 50;

/** Longueur maximale d'un terme de recherche, avant échappement. */
export const DISCOVERY_MAX_QUERY_LENGTH = 120;

class PaginatedDiscoveryQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
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
}
