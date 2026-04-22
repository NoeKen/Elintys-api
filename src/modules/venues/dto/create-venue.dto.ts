import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddressDto {
  @ApiProperty({ example: '1234 Rue Sainte-Catherine Ouest', maxLength: 300 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(300)
  street!: string;

  @ApiProperty({ example: 'Montréal', maxLength: 100 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  city!: string;

  @ApiPropertyOptional({ example: 'Québec', maxLength: 50 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(50)
  province?: string;

  @ApiPropertyOptional({ example: 'H3G 1P9', maxLength: 10 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(10)
  postalCode?: string;
}

export class CreateVenueDto {
  @ApiProperty({ example: 'Salle Windsor', description: 'Nom de la salle', maxLength: 200 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'Salle de réception historique au cœur du centre-ville.', maxLength: 3000 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(3000)
  description?: string;

  @ApiProperty({ type: () => AddressDto, description: 'Adresse complète de la salle' })
  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @ApiProperty({ example: 300, description: 'Capacité maximale en personnes', minimum: 1 })
  @IsInt()
  @Min(1)
  capacity!: number;

  @ApiPropertyOptional({ example: 2500, description: 'Prix par jour en dollars', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePerDay?: number;

  @ApiPropertyOptional({ example: 'info@sallewindsor.ca' })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ example: '514-555-9876', maxLength: 20 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(20)
  contactPhone?: string;
}
