import { IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { InvitationType } from '../invitation.schema';

export class CreateInvitationDto {
  @IsEmail()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  email!: string;

  @IsString()
  @MaxLength(100)
  @Transform(({ value }: { value: string }) => value?.trim())
  name!: string;

  @IsEnum(InvitationType)
  type!: InvitationType;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(({ value }: { value: string }) => value?.trim())
  category?: string;

  @IsOptional()
  @IsMongoId()
  eventId?: string;
}
