import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { trimValue } from '../../../shared/utils/transform';

export class UpdateProfileDto {
  @ApiProperty({ example: 'Marie', minLength: 1, maxLength: 50 })
  @Transform(trimValue)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  firstName!: string;

  @ApiProperty({ example: 'Tremblay', minLength: 1, maxLength: 50 })
  @Transform(trimValue)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  lastName!: string;
}
