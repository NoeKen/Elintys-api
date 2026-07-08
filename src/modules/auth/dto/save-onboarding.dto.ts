import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimStringArray = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    : value;

export class SaveOnboardingDto {
  @ApiPropertyOptional({ type: [String], description: "Types d'événements préférés" })
  @IsOptional()
  @Transform(trimStringArray)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  eventTypes?: string[];

  @ApiPropertyOptional({ description: "Fréquence d'organisation" })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  frequency?: string;

  @ApiPropertyOptional({ description: 'Photo de profil optionnelle' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(180)
  avatar?: string;

  @ApiPropertyOptional({ description: "Nom d'affichage ou entreprise" })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ description: 'Ville principale' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ description: 'Catégorie principale prestataire' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({ description: 'Logo ou photo prestataire' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(180)
  logo?: string;

  @ApiPropertyOptional({ description: 'Description courte prestataire', maxLength: 200 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: 'Zone de service' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  serviceArea?: string;

  @ApiPropertyOptional({ description: 'Tarif indicatif optionnel' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  rate?: string;

  @ApiPropertyOptional({ description: "Nom de l'espace" })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(120)
  venueName?: string;

  @ApiPropertyOptional({ description: "Type d'espace" })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  venueType?: string;

  @ApiPropertyOptional({ description: 'Capacité', minimum: 1, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity?: number;

  @ApiPropertyOptional({ description: 'Adresse, ville ou quartier' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(220)
  address?: string;

  @ApiPropertyOptional({ description: 'Photo principale du lieu' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(180)
  photo?: string;

  @ApiPropertyOptional({ type: [String], description: 'Disponibilité générale par jours' })
  @IsOptional()
  @Transform(trimStringArray)
  @IsArray()
  @ArrayMaxSize(7)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  availability?: string[];
}
