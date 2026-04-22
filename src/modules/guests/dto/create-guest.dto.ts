import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGuestDto {
  @ApiProperty({ example: 'Jean-Pierre Lafleur', description: 'Nom de l\'invité', maxLength: 100 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'jp.lafleur@example.com', description: 'Courriel de l\'invité' })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'Table 3 — allergie aux arachides', maxLength: 500 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(500)
  note?: string;
}
