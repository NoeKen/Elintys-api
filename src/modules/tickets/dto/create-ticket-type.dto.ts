import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTicketTypeDto {
  @ApiProperty({ example: 'Billet VIP', description: 'Nom du type de billet', maxLength: 100 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 5000, description: 'Prix en cents (ex: 5000 = 50,00 $)', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @ApiProperty({ example: 100, description: 'Nombre de billets disponibles', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({ example: false, description: 'Billet gratuit' })
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @ApiPropertyOptional({ example: 'Accès prioritaire + cocktail de bienvenue', maxLength: 500 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(500)
  description?: string;
}
