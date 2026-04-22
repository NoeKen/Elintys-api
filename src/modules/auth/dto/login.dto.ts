import { IsEmail, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'marie@example.com', description: 'Adresse courriel' })
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'motdepasse123', description: 'Mot de passe', minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;
}
