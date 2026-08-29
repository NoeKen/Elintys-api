import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { PayPalWebhookController } from './paypal-webhook.controller';
import { PayPalWebhookVerifier, WebhookRejectionReason } from './providers/paypal/paypal-webhook.verifier';
import { PayPalWebhookService } from './providers/paypal/paypal-webhook.service';
import { PayPalHttpClient } from './providers/paypal/paypal-http.client';

function build(options: {
  enabled?: boolean;
  verification?: unknown;
  outcome?: string;
} = {}) {
  const verify = jest.fn().mockResolvedValue(
    options.verification ?? {
      verified: true,
      event: { eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: {}, createTime: null },
    },
  );
  const handle = jest.fn().mockResolvedValue(options.outcome ?? 'processed');
  const controller = new PayPalWebhookController(
    { verify } as unknown as PayPalWebhookVerifier,
    { handle } as unknown as PayPalWebhookService,
    { enabled: options.enabled ?? true } as unknown as PayPalHttpClient,
  );
  return { controller, verify, handle };
}

function request(rawBody?: Buffer): RawBodyRequest<Request> {
  return {
    headers: { 'paypal-transmission-id': 't-1' },
    rawBody,
  } as unknown as RawBodyRequest<Request>;
}

const withBody = () => request(Buffer.from('{}'));

afterEach(() => jest.clearAllMocks());

describe('PayPalWebhookController', () => {
  it('devrait accepter un webhook authentifié et traité', async () => {
    const { controller, handle } = build();
    await expect(controller.webhook(withBody())).resolves.toEqual({ received: true });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it.each(['duplicate', 'ignored', 'order_not_found'])(
    'devrait répondre 200 pour l\'issue %s afin d\'éviter un rejeu inutile',
    async (outcome) => {
      const { controller } = build({ outcome });
      await expect(controller.webhook(withBody())).resolves.toEqual({ received: true });
    },
  );

  it('devrait refuser lorsque PayPal n\'est pas configuré', async () => {
    const { controller, verify } = build({ enabled: false });
    await expect(controller.webhook(withBody())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('devrait refuser sans corps brut — la signature serait invérifiable', async () => {
    const { controller, verify } = build();
    await expect(controller.webhook(request())).rejects.toBeInstanceOf(BadRequestException);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    WebhookRejectionReason.MISSING_HEADERS,
    WebhookRejectionReason.UNTRUSTED_CERT_URL,
    WebhookRejectionReason.MALFORMED_BODY,
    WebhookRejectionReason.VERIFICATION_FAILED,
  ])('devrait répondre 400 sans divulguer la raison (%s)', async (reason) => {
    const { controller, handle } = build({ verification: { verified: false, reason } });
    await expect(controller.webhook(withBody())).rejects.toThrow('WEBHOOK_NOT_AUTHENTIC');
    expect(handle).not.toHaveBeenCalled();
  });

  it('devrait répondre 503 lorsque la vérification est indisponible', async () => {
    const { controller } = build({
      verification: { verified: false, reason: WebhookRejectionReason.VERIFICATION_UNAVAILABLE },
    });
    await expect(controller.webhook(withBody())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('devrait répondre 503 sur échec de traitement pour provoquer un rejeu', async () => {
    const { controller } = build({ outcome: 'failed' });
    await expect(controller.webhook(withBody())).rejects.toThrow('WEBHOOK_PROCESSING_FAILED');
  });

  it('devrait exposer la route en @Public — PayPal ne porte pas de JWT', () => {
    expect(Reflect.getMetadata('isPublic', PayPalWebhookController.prototype.webhook)).toBe(true);
  });
});
