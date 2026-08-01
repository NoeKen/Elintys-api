import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsEnum, ValidateNested } from 'class-validator';
import { AdmissionMode, EventDiscoverability } from '../event.schema';
import { EventAccessPolicyDto } from './create-event.dto';

export class UpdateEventAccessConfigurationDto {
  @ApiProperty({ enum: EventDiscoverability })
  @IsEnum(EventDiscoverability)
  discoverability!: EventDiscoverability;

  @ApiProperty({ type: () => EventAccessPolicyDto })
  @ValidateNested()
  @Type(() => EventAccessPolicyDto)
  accessPolicy!: EventAccessPolicyDto;

  @ApiProperty({ enum: AdmissionMode, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(AdmissionMode, { each: true })
  admissionModes!: AdmissionMode[];
}
