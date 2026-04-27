import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({ example: 'abc123token', description: 'Token de vérification reçu par courriel' })
  @IsString()
  token!: string;
}
