import { IsEmail } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimLowerValue } from '../../../shared/utils/transform';
import { ApiProperty } from '@nestjs/swagger';

export class ResendVerificationDto {
  @ApiProperty({ example: 'marie@example.com', description: 'Adresse courriel du compte à vérifier' })
  @Transform(trimLowerValue)
  @IsEmail()
  email!: string;
}
