import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { PayPalWebhookVerifier } from './providers/paypal/paypal-webhook.verifier';
import { PayPalWebhookService } from './providers/paypal/paypal-webhook.service';
import { PayPalHttpClient } from './providers/paypal/paypal-http.client';

/**
 * Réception des webhooks PayPal.
 *
 * SÉQUENCE NON NÉGOCIABLE
 * -----------------------
 *   1. le fournisseur doit être activé ;
 *   2. le corps BRUT doit être disponible (une re-sérialisation invaliderait
 *      la signature) ;
 *   3. la signature est vérifiée par l'API officielle PayPal ;
 *   4. seulement ensuite l'événement est dédupliqué puis traité.
 *
 * Un corps JSON plausible n'est jamais suffisant.
 *
 * CODES DE RÉPONSE
 * ----------------
 * - 200 : événement authentifié et pris en charge (traité, doublon ou ignoré).
 *         PayPal ne doit pas rejouer un événement déjà appliqué.
 * - 400 : signature invalide, en-têtes manquants ou corps altéré. Aucun détail
 *         n'est renvoyé — un attaquant n'apprend rien de la raison du rejet.
 * - 503 : PayPal indisponible pour la vérification, ou traitement en échec :
 *         PayPal rejouera.
 */
@ApiTags('Payments')
@Controller('payments/paypal')
export class PayPalWebhookController {
  constructor(
    private readonly verifier: PayPalWebhookVerifier,
    private readonly webhookService: PayPalWebhookService,
    private readonly http: PayPalHttpClient,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Webhook PayPal — réception des événements de paiement',
    description:
      "L'authenticité est vérifiée par l'API officielle PayPal. Le contenu du webhook n'est jamais traité comme une preuve de paiement : le serveur relit l'état de la commande chez PayPal.",
  })
  @ApiResponse({ status: 200, description: 'Événement authentifié et pris en charge' })
  @ApiResponse({ status: 400, description: 'Webhook non authentifié' })
  @ApiResponse({ status: 503, description: 'Vérification ou traitement indisponible' })
  async webhook(@Req() req: RawBodyRequest<Request>): Promise<{ received: boolean }> {
    if (!this.http.enabled) {
      throw new ServiceUnavailableException('PAYPAL_NOT_CONFIGURED');
    }
    if (!req.rawBody) {
      // Sans corps brut, la signature ne peut pas être vérifiée : on refuse.
      throw new BadRequestException('WEBHOOK_RAW_BODY_UNAVAILABLE');
    }

    const verification = await this.verifier.verify(req.headers, req.rawBody);
    if (!verification.verified) {
      if (verification.reason === 'VERIFICATION_UNAVAILABLE') {
        throw new ServiceUnavailableException('WEBHOOK_VERIFICATION_UNAVAILABLE');
      }
      // Message volontairement uniforme : la raison exacte n'est pas divulguée.
      throw new BadRequestException('WEBHOOK_NOT_AUTHENTIC');
    }

    const outcome = await this.webhookService.handle(verification.event);
    if (outcome === 'failed') {
      // 503 → PayPal rejouera l'événement.
      throw new ServiceUnavailableException('WEBHOOK_PROCESSING_FAILED');
    }
    return { received: true };
  }
}
