import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';

export class ScanTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(trimValue)
  qrCode!: string;
}
