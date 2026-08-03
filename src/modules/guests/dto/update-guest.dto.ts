import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GuestStatus } from '../guest.schema';

export class UpdateGuestDto {
  @ApiPropertyOptional({ enum: GuestStatus, example: GuestStatus.CONFIRMED, description: 'Statut de présence' })
  @IsOptional()
  @IsEnum(GuestStatus)
  status?: GuestStatus;

  @ApiPropertyOptional({ example: 'Table 5 — végétalien', maxLength: 500 })
  @IsOptional()
  @Transform(trimValue)
  @IsString()
  @MaxLength(500)
  note?: string;
}
