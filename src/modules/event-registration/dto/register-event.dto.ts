import { IsMongoId } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterEventDto {
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: "MongoDB ObjectId de l'événement" })
  @IsMongoId()
  eventId!: string;
}
