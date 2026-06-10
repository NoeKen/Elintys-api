import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
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
  @Transform(({ value }: { value: string }) => value?.trim())
  responseMessage?: string;
}
