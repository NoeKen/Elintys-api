import { IsInt, IsMongoId, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PurchaseTicketDto {
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId du type de billet' })
  @IsMongoId()
  ticketTypeId!: string;

  @ApiProperty({ example: 2, description: 'Nombre de billets à acheter', minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}
