import { IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { trimValue } from '../../../shared/utils/transform';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorRequestSource } from '../vendor.schema';

export class ExternalContactDto {
  @ApiProperty({ example: 'Jean Tremblay Photo' })
  @IsString()
  @MaxLength(200)
  @Transform(trimValue)
  name!: string;

  @ApiPropertyOptional({ example: 'jean@example.com' })
  @IsOptional()
  @IsEmail()
  @IsString()
  @MaxLength(200)
  @Transform(trimValue)
  email?: string;

  @ApiPropertyOptional({ example: '514-555-0000' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'photographe' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimValue)
  category?: string;
}

export class CreateVendorRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  vendorId?: string;

  @ApiPropertyOptional({ enum: VendorRequestSource, default: VendorRequestSource.PLATFORM })
  @IsOptional()
  @IsEnum(VendorRequestSource)
  source?: VendorRequestSource;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trimValue)
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => ExternalContactDto)
  externalContact?: ExternalContactDto;
}
