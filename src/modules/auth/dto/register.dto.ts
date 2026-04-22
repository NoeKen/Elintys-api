import { IsEmail, IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../user.schema';

export class RegisterDto {
  @ApiProperty({ example: 'Marie Tremblay', description: 'Nom complet', maxLength: 100 })
  @Transform(({ value }: { value: string }) => value?.trim())
  @IsString()
  @MaxLength(100)
  fullName!: string;

  @ApiProperty({ example: 'marie@example.com', description: 'Adresse courriel' })
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'motdepasse123', description: 'Mot de passe (8–72 caractères)', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.PARTICIPANT, description: 'Rôle du compte' })
  @IsEnum(UserRole)
  role!: UserRole;
}
