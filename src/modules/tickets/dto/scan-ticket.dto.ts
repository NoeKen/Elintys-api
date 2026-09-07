import { IsMongoId, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { trimValue } from '../../../shared/utils/transform';

export class ScanTicketDto {
  /**
   * L'événement scanné fait partie du contrat.
   *
   * Il n'est pas décoratif : le serveur s'en sert pour (1) autoriser le
   * scanneur sur CET événement et (2) refuser un billet appartenant à un autre
   * événement. Sans lui, le porteur d'un billet de l'événement B pouvait entrer
   * à l'événement A.
   */
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: "MongoDB ObjectId de l'événement scanné" })
  @IsMongoId()
  eventId!: string;

  @ApiProperty({ example: '2C1E-1227-72BA', description: 'Code QR imprimé sur le billet', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(trimValue)
  qrCode!: string;
}
