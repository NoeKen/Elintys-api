import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { GuestStatus } from '../guest.schema';

export class UpdateGuestDto {
  @IsOptional()
  @IsEnum(GuestStatus)
  status?: GuestStatus;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(500)
  note?: string;
}
