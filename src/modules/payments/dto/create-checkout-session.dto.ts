import { IsEmail, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCheckoutSessionDto {
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId du type de billet' })
  @IsMongoId()
  ticketTypeId!: string;

  @ApiProperty({ example: 2, description: 'Nombre de billets', minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @ApiPropertyOptional({ example: 'marie@exemple.ca', description: 'Courriel invité (achat sans compte)' })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  guestEmail?: string;

  @ApiPropertyOptional({ example: 'Marie Dupuis', description: 'Nom de l\'invité' })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  guestName?: string;
}
