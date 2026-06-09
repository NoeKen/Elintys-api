import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorRequestStatus } from '../vendor.schema';

export class RespondVendorRequestDto {
  @ApiProperty({ enum: [VendorRequestStatus.ACCEPTED, VendorRequestStatus.DECLINED] })
  @IsEnum([VendorRequestStatus.ACCEPTED, VendorRequestStatus.DECLINED])
  status!: VendorRequestStatus.ACCEPTED | VendorRequestStatus.DECLINED;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: string }) => value?.trim())
  responseMessage?: string;
}
