import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiBearerAuth('access-token')
  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer une session de paiement Stripe Checkout' })
  @ApiHeader({ name: 'X-Event-Access-Grant', required: false, description: "Jeton d'accès court terme" })
  @ApiResponse({ status: 201, description: 'URL de la session Stripe retournée' })
  @ApiResponse({ status: 400, description: 'Billet gratuit ou stock insuffisant' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 404, description: 'Type de billet introuvable' })
  createCheckoutSession(
    @Body() dto: CreateCheckoutSessionDto,
    @CurrentUser() user: JwtPayload,
    @Headers('x-event-access-grant') accessGrantHeader?: string,
  ): Promise<{ sessionUrl: string }> {
    return this.paymentsService.createCheckoutSession(dto, user.sub, accessGrantHeader);
  }

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook Stripe — réception des événements de paiement' })
  @ApiResponse({ status: 200, description: 'Événement traité' })
  @ApiResponse({ status: 400, description: 'Signature invalide' })
  async webhook(@Req() req: RawBodyRequest<Request>): Promise<{ received: boolean }> {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      throw new BadRequestException('En-tête stripe-signature manquant.');
    }

    if (!req.rawBody) {
      throw new BadRequestException('Corps brut de la requête indisponible.');
    }

    const event = this.paymentsService.handleWebhook(req.rawBody, signature);
    await this.paymentsService.processWebhookEvent(event);

    return { received: true };
  }

  @ApiBearerAuth('access-token')
  @Post('refund/:purchaseId')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Rembourser un billet (organisateur uniquement)' })
  @ApiParam({ name: 'purchaseId', description: 'MongoDB ObjectId du TicketPurchase' })
  @ApiResponse({ status: 200, description: 'Billet remboursé' })
  @ApiResponse({ status: 400, description: 'Billet non valide pour remboursement' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Billet introuvable' })
  @ApiResponse({ status: 503, description: 'Stripe non configuré' })
  refundTicket(@Param('purchaseId') purchaseId: string, @CurrentUser() user: JwtPayload) {
    return this.paymentsService.refundTicket(purchaseId, user.sub);
  }
}
