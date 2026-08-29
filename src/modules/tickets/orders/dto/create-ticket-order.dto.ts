import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TestPaymentScenario } from '../../../payments/providers/test-payment.provider';

export const MAX_ORDER_LINES = 5;
export const MAX_QUANTITY_PER_LINE = 10;

export class CreateTicketOrderLineDto {
  @ApiProperty({ example: '664f1a2b3c4d5e6f7a8b9c0d', description: 'MongoDB ObjectId du type de billet payant' })
  @IsMongoId()
  ticketTypeId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: MAX_QUANTITY_PER_LINE })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity!: number;
}

export class CreateTicketOrderDto {
  @ApiProperty({ type: [CreateTicketOrderLineDto], description: 'Lignes de commande — un type de billet par ligne' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateTicketOrderLineDto)
  lines!: CreateTicketOrderLineDto[];

  /**
   * Scénario de simulation de paiement.
   *
   * Accepté UNIQUEMENT lorsque le fournisseur de paiement de test est autorisé
   * (`ELINTYS_ENV=dev` + `TEST_PAYMENT_PROVIDER_ENABLED=true`). Rejeté partout
   * ailleurs : ce champ ne peut jamais influencer un paiement réel.
   */
  @ApiPropertyOptional({
    enum: TestPaymentScenario,
    description: 'Développement uniquement — scénario du fournisseur de paiement simulé',
  })
  @IsOptional()
  @IsEnum(TestPaymentScenario)
  paymentScenario?: TestPaymentScenario;
}
