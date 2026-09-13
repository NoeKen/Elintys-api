import { IsArray, IsEmail, IsIn, IsString, ArrayMaxSize, ArrayMinSize, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { trimLowerValue, trimValue } from '../../../shared/utils/transform';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../user.schema';

const PUBLIC_REGISTRATION_ROLES = [
  UserRole.ORGANISATEUR,
  UserRole.PRESTATAIRE,
  UserRole.GESTIONNAIRE_SALLE,
  UserRole.PARTICIPANT,
] as const;

export class RegisterDto {
  @ApiProperty({ example: 'Marie Tremblay', description: 'Nom complet', maxLength: 100 })
  @Transform(trimValue)
  @IsString()
  @MaxLength(100)
  fullName!: string;

  @ApiProperty({ example: 'marie@example.com', description: 'Adresse courriel' })
  @Transform(trimLowerValue)
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'motdepasse123', description: 'Mot de passe (8–72 caractères)', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({ enum: PUBLIC_REGISTRATION_ROLES, isArray: true, example: [UserRole.ORGANISATEUR], description: 'Rôle public initial du compte (un seul rôle à l’inscription)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @IsIn(PUBLIC_REGISTRATION_ROLES, { each: true })
  roles!: UserRole[];
}
