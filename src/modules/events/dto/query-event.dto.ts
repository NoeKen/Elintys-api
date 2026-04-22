import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EventStatus, EventVisibility } from '../event.schema';

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
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  city?: string;
}
