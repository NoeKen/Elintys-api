import { Injectable, Logger } from '@nestjs/common';
import { PayPalHttpClient } from './paypal-http.client';

export const PAYPAL_WEBHOOK_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

export type PayPalWebhookHeaderName = (typeof PAYPAL_WEBHOOK_HEADERS)[number];

export enum WebhookRejectionReason {
  MISSING_HEADERS = 'MISSING_HEADERS',
  UNTRUSTED_CERT_URL = 'UNTRUSTED_CERT_URL',
  MALFORMED_BODY = 'MALFORMED_BODY',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  VERIFICATION_UNAVAILABLE = 'VERIFICATION_UNAVAILABLE',
}

export interface VerifiedWebhookEvent {
  /** Identifiant d'ÉVÉNEMENT PayPal — la clé de déduplication du transport. */
  eventId: string;
  eventType: string;
  /** Ressource brute de l'événement, non encore traduite. */
  resource: Record<string, unknown>;
  createTime: string | null;
}

export type WebhookVerificationResult =
  | { verified: true; event: VerifiedWebhookEvent }
  | { verified: false; reason: WebhookRejectionReason };

/**
 * Hôtes autorisés pour `paypal-cert-url`.
 *
 * Défense en profondeur : même si l'API de vérification de PayPal fait
 * autorité, on refuse en amont toute URL de certificat qui ne provient pas
 * d'un domaine PayPal. Cela évite d'inviter le service de vérification à
 * suivre une URL contrôlée par un tiers.
 */
const TRUSTED_CERT_HOSTS = /(^|\.)paypal\.com$/;

/**
 * Vérification d'authenticité des webhooks PayPal.
 *
 * RÈGLE ABSOLUE : un webhook n'est JAMAIS considéré comme valide parce que son
 * corps est un JSON plausible. Il n'est accepté que si l'API officielle
 * `/v1/notifications/verify-webhook-signature` répond `SUCCESS` pour le
 * `webhook_id` configuré.
 *
 * Sont donc rejetés : en-têtes manquants, signature invalide, corps modifié
 * après signature, webhook_id incorrect, et certificat hors domaine PayPal.
 * Le rejeu et les doublons sont traités en amont par la déduplication
 * persistante (`eventId`), pas ici.
 */
@Injectable()
export class PayPalWebhookVerifier {
  private readonly logger = new Logger(PayPalWebhookVerifier.name);

  constructor(private readonly http: PayPalHttpClient) {}

  async verify(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<WebhookVerificationResult> {
    const collected: Partial<Record<PayPalWebhookHeaderName, string>> = {};
    for (const name of PAYPAL_WEBHOOK_HEADERS) {
      const value = headers[name];
      const single = Array.isArray(value) ? value[0] : value;
      if (!single || typeof single !== 'string' || !single.trim()) {
        return this.reject(WebhookRejectionReason.MISSING_HEADERS);
      }
      collected[name] = single;
    }

    if (!isTrustedCertUrl(collected['paypal-cert-url']!)) {
      return this.reject(WebhookRejectionReason.UNTRUSTED_CERT_URL);
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return this.reject(WebhookRejectionReason.MALFORMED_BODY);
    }

    const eventId = typeof event.id === 'string' ? event.id : '';
    const eventType = typeof event.event_type === 'string' ? event.event_type : '';
    if (!eventId || !eventType) {
      return this.reject(WebhookRejectionReason.MALFORMED_BODY);
    }

    let verificationStatus: string;
    try {
      const response = await this.http.request<{ verification_status?: unknown }>({
        method: 'POST',
        path: '/v1/notifications/verify-webhook-signature',
        body: {
          auth_algo: collected['paypal-auth-algo'],
          cert_url: collected['paypal-cert-url'],
          transmission_id: collected['paypal-transmission-id'],
          transmission_sig: collected['paypal-transmission-sig'],
          transmission_time: collected['paypal-transmission-time'],
          // L'identifiant configuré côté serveur : un webhook signé pour un
          // AUTRE webhook_id échoue ici.
          webhook_id: this.http.webhookId,
          webhook_event: event,
        },
      });
      verificationStatus =
        typeof response.verification_status === 'string' ? response.verification_status : '';
    } catch {
      // Indisponibilité de PayPal : on ne devine pas, on refuse. Le webhook
      // sera rejoué par PayPal, et la réconciliation par sync-payment reste
      // disponible côté serveur.
      return this.reject(WebhookRejectionReason.VERIFICATION_UNAVAILABLE);
    }

    if (verificationStatus !== 'SUCCESS') {
      return this.reject(WebhookRejectionReason.VERIFICATION_FAILED);
    }

    return {
      verified: true,
      event: {
        eventId,
        eventType,
        resource:
          typeof event.resource === 'object' && event.resource !== null
            ? (event.resource as Record<string, unknown>)
            : {},
        createTime: typeof event.create_time === 'string' ? event.create_time : null,
      },
    };
  }

  private reject(reason: WebhookRejectionReason): WebhookVerificationResult {
    // Aucun en-tête, aucune signature, aucun corps n'est journalisé.
    this.logger.warn(`Webhook PayPal rejeté: ${reason}`);
    return { verified: false, reason };
  }
}

export function isTrustedCertUrl(certUrl: string): boolean {
  try {
    const url = new URL(certUrl);
    return url.protocol === 'https:' && TRUSTED_CERT_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}
