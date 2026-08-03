import { IsEmail, IsInt, IsMongoId, IsOptional, IsPhoneNumber, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimLowerValue, trimValue } from '../../../shared/utils/transform';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PurchaseTicketDto {
  @ApiPropertyOptional({ description: "Jeton d'accès court terme obtenu après validation d'un code" })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  accessGrant?: string;

  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId du type de billet' })
  @IsMongoId()
  ticketTypeId!: string;

  @ApiProperty({ example: 2, description: 'Nombre de billets à acheter', minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @ApiPropertyOptional({ example: 'marie@exemple.ca', description: 'Courriel invité (achat sans compte)' })
  @IsOptional()
  @Transform(trimLowerValue)
  @IsEmail()
  guestEmail?: string;

  @ApiPropertyOptional({ example: 'Marie Dupuis', description: 'Nom de l\'invité' })
  @ValidateIf(o => !!o.guestEmail)
  @IsString()
  @MaxLength(100)
  @Transform(trimValue)
  guestName?: string;

  @ApiPropertyOptional({ example: '+15141234567', description: 'Téléphone de l\'invité' })
  @IsOptional()
  @IsPhoneNumber(undefined)
  guestPhone?: string;
}
