import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimLowerValue, trimValue } from '../../../shared/utils/transform';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGuestDto {
  @ApiProperty({ example: 'Jean-Pierre Lafleur', description: 'Nom de l\'invité', maxLength: 100 })
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'jp.lafleur@example.com', description: 'Courriel de l\'invité' })
  @IsOptional()
  @Transform(trimLowerValue)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'Table 3 — allergie aux arachides', maxLength: 500 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(500)
  note?: string;
}
