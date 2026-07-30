import { IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorRequestSource } from '../vendor.schema';

export class ExternalContactDto {
  @ApiProperty({ example: 'Jean Tremblay Photo' })
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: string }) => value?.trim())
  name!: string;

  @ApiPropertyOptional({ example: 'jean@example.com' })
  @IsOptional()
  @IsEmail()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: string }) => value?.trim())
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
  @Transform(({ value }: { value: string }) => value?.trim())
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
  @Transform(({ value }: { value: string }) => value?.trim())
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => ExternalContactDto)
  externalContact?: ExternalContactDto;
}
