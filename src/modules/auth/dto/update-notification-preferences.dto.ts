import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  vendorRequestReceived?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  vendorResponse?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  venueBookingReceived?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  venueResponse?: boolean;
}
