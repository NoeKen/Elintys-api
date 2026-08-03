import { IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimLowerValue, trimValue } from '../../../shared/utils/transform';
import { InvitationType } from '../invitation.schema';

export class CreateInvitationDto {
  @IsEmail()
  @Transform(trimLowerValue)
  email!: string;

  @IsString()
  @MaxLength(100)
  @Transform(trimValue)
  name!: string;

  @IsEnum(InvitationType)
  type!: InvitationType;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimValue)
  category?: string;

  @IsOptional()
  @IsMongoId()
  eventId?: string;
}
