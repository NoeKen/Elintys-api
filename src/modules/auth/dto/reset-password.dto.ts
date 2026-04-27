import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ example: 'abc123token', description: 'Token de réinitialisation reçu par courriel' })
  @IsString()
  token!: string;

  @ApiProperty({ example: 'NouveauMotDePasse1', description: 'Nouveau mot de passe (8–72 caractères)', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
