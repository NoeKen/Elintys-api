import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

class AddressDto {
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(300)
  street!: string;

  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  city!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(50)
  province?: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(10)
  postalCode?: string;
}

export class CreateVenueDto {
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(3000)
  description?: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @IsInt()
  @Min(1)
  capacity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePerDay?: number;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(20)
  contactPhone?: string;
}
