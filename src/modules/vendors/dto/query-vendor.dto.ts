import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VendorCategory } from '../vendor.schema';

export enum VendorPriceTier {
  BUDGET = '$',
  STANDARD = '$$',
  PREMIUM = '$$$',
  LUXURY = '$$$$',
}

export class QueryVendorDto {
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

  @ApiPropertyOptional({ enum: VendorCategory, description: 'Filtrer par catégorie' })
  @IsOptional()
  @IsEnum(VendorCategory)
  category?: VendorCategory;

  @ApiPropertyOptional({ example: 'Montréal', description: 'Filtrer par zone de service' })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    enum: VendorPriceTier,
    description: 'Filtrer par prix de départ ($ ≤ 1000, $$ ≤ 2500, $$$ ≤ 5000, $$$$ > 5000 CAD)',
  })
  @IsOptional()
  @IsEnum(VendorPriceTier)
  price?: VendorPriceTier;
}
