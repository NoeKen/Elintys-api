import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VenueBookingStatus } from '../venue.schema';

export class RespondVenueBookingDto {
  @ApiProperty({ enum: [VenueBookingStatus.CONFIRMED, VenueBookingStatus.REFUSED] })
  @IsEnum([VenueBookingStatus.CONFIRMED, VenueBookingStatus.REFUSED])
  status!: VenueBookingStatus.CONFIRMED | VenueBookingStatus.REFUSED;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trimValue)
  responseMessage?: string;
}
