import { IsDateString, IsMongoId, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVenueBookingDto {
  @ApiProperty({ description: 'ID du profil de salle' })
  @IsMongoId()
  venueId!: string;

  @ApiProperty({ example: '2025-12-01T18:00:00Z' })
  @IsDateString()
  bookingStart!: string;

  @ApiProperty({ example: '2025-12-02T02:00:00Z' })
  @IsDateString()
  bookingEnd!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: string }) => value?.trim())
  message?: string;

  @ApiPropertyOptional({ description: 'Prix total négocié (CAD, en cents)', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalPrice?: number;
}
