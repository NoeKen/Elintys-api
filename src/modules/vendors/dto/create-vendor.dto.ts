import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorCategory } from '../vendor.schema';

export class PriceRangeDto {
  @ApiPropertyOptional({ example: 500, description: 'Prix minimum en dollars' })
  @IsOptional()
  min?: number;

  @ApiPropertyOptional({ example: 5000, description: 'Prix maximum en dollars' })
  @IsOptional()
  max?: number;
}

export class CreateVendorDto {
  @ApiProperty({ example: 'Photo Lumière Montréal', description: 'Nom de l\'entreprise', maxLength: 200 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  businessName!: string;

  @ApiProperty({ enum: VendorCategory, example: VendorCategory.PHOTOGRAPHE, description: 'Catégorie de service' })
  @IsEnum(VendorCategory)
  category!: VendorCategory;

  @ApiPropertyOptional({ example: 'Photographe professionnel spécialisé en événements corporatifs.', maxLength: 3000 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(3000)
  description?: string;

  @ApiPropertyOptional({ type: () => PriceRangeDto, description: 'Fourchette de prix' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRangeDto)
  priceRange?: PriceRangeDto;

  @ApiPropertyOptional({ example: 'Montréal et banlieue', maxLength: 200 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  serviceArea?: string;

  @ApiPropertyOptional({ example: 'contact@photolumiere.ca' })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ example: '514-555-0123', maxLength: 20 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(20)
  contactPhone?: string;
}
