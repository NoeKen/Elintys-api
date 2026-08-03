import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimLowerValue } from '../../../shared/utils/transform';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'marie@example.com', description: 'Adresse courriel' })
  @Transform(trimLowerValue)
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'motdepasse123', description: 'Mot de passe', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
