import { Transform } from 'class-transformer';
import { trimLowerValue, trimValue } from '../../../shared/utils/transform';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { WaitlistRole, WaitlistSource } from '../waitlist.schema';

export class CreateWaitlistEntryDto {
  @ApiProperty({ example: 'Marie' })
  @Transform(trimValue)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  firstName!: string;

  @ApiProperty({ example: 'marie@example.com' })
  @Transform(trimLowerValue)
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: WaitlistRole, example: WaitlistRole.ORGANISATEUR })
  @IsEnum(WaitlistRole)
  role!: WaitlistRole;

  @ApiProperty({ enum: WaitlistSource, example: WaitlistSource.CTA })
  @IsEnum(WaitlistSource)
  source!: WaitlistSource;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  consentMarketing?: boolean;
}
