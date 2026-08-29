import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayPalConfig } from '../../../../config/paypal-environment';

export const PAYPAL_NOT_CONFIGURED = 'PAYPAL_NOT_CONFIGURED';
export const PAYPAL_UNAVAILABLE = 'PAYPAL_UNAVAILABLE';
export const PAYPAL_AUTH_FAILED = 'PAYPAL_AUTH_FAILED';

/** Délai maximal d'un appel PayPal. Au-delà, la requête est abandonnée. */
export const PAYPAL_REQUEST_TIMEOUT_MS = 10_000;
/** Tentatives totales (1 initiale + 2 reprises) sur erreur transitoire. */
export const PAYPAL_MAX_ATTEMPTS = 3;
/** Marge de sécurité retranchée à la durée de vie du jeton OAuth. */
export const PAYPAL_TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface PayPalRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** `PayPal-Request-Id` — idempotence côté fournisseur. */
  requestId?: string;
  /** Représentation minimale attendue en réponse. */
  prefer?: string;
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    /** Nom d'erreur PayPal normalisé. Jamais le corps brut. */
    readonly issue: string,
    readonly retriable: boolean,
  ) {
    super(`PAYPAL_API_ERROR:${status}:${issue}`);
    this.name = 'PayPalApiError';
  }
}

/** Configuration PayPal dont les credentials sont garanties présentes. */
export type PayPalCredentials = PayPalConfig & {
  clientId: string;
  clientSecret: string;
  webhookId: string;
};

interface TokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Client HTTP PayPal — OAuth2 client_credentials + appels REST.
 *
 * SÉCURITÉ
 * --------
 * - Le `client_secret` n'est jamais journalisé, ni l'en-tête Authorization,
 *   ni le jeton d'accès, ni le corps des réponses.
 * - Le jeton est gardé EN MÉMOIRE uniquement, jamais persisté en base : il est
 *   court, renouvelable à volonté, et le stocker créerait une surface inutile.
 * - Les erreurs PayPal sont traduites en codes stables ; le corps brut du
 *   fournisseur ne remonte jamais au client HTTP d'Elintys.
 *
 * ROBUSTESSE
 * ----------
 * - Timeout dur par requête (AbortController).
 * - Reprises BORNÉES, uniquement sur erreurs transitoires (429, 5xx, réseau),
 *   avec back-off exponentiel. Jamais de reprise sur 4xx métier.
 * - Le cache de jeton est par instance : deux instances API obtiennent chacune
 *   le leur, ce qui est le comportement attendu par PayPal.
 */
@Injectable()
export class PayPalHttpClient {
  private readonly logger = new Logger(PayPalHttpClient.name);
  private tokenCache: TokenCacheEntry | null = null;
  private inFlightToken: Promise<string> | null = null;

  constructor(private readonly configService: ConfigService) {}

  get config(): PayPalConfig {
    return this.configService.getOrThrow<PayPalConfig>('paypal');
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private requireConfig(): PayPalCredentials {
    const config = this.config;
    if (!config.enabled || !config.clientId || !config.clientSecret || !config.webhookId) {
      throw new ServiceUnavailableException(PAYPAL_NOT_CONFIGURED);
    }
    return config as PayPalCredentials;
  }

  /** Identifiant du webhook configuré, requis par la vérification de signature. */
  get webhookId(): string {
    return this.requireConfig().webhookId;
  }

  /**
   * Jeton d'accès OAuth, mis en cache jusqu'à sa date d'expiration moins une
   * marge. Les appels concurrents partagent la même promesse : un seul aller-
   * retour PayPal, jamais N.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs > now) {
      return this.tokenCache.accessToken;
    }
    if (this.inFlightToken) return this.inFlightToken;

    this.inFlightToken = this.fetchAccessToken()
      .finally(() => {
        this.inFlightToken = null;
      });
    return this.inFlightToken;
  }

  private async fetchAccessToken(): Promise<string> {
    const config = this.requireConfig();
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

    const response = await this.execute(
      `${config.baseUrl}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          // Jamais journalisé.
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
      'oauth-token',
    );

    const payload = (await this.readJson(response)) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!response.ok || !payload.access_token) {
      this.logger.error(`PayPal OAuth échoué (status ${response.status})`);
      throw new ServiceUnavailableException(PAYPAL_AUTH_FAILED);
    }

    const lifetimeMs = Math.max(0, (payload.expires_in ?? 0) * 1000 - PAYPAL_TOKEN_EXPIRY_MARGIN_MS);
    this.tokenCache = {
      accessToken: payload.access_token,
      expiresAtMs: Date.now() + lifetimeMs,
    };
    return payload.access_token;
  }

  /** Invalide le jeton en cache (401 reçu d'un appel métier). */
  invalidateToken(): void {
    this.tokenCache = null;
  }

  /** Appel REST authentifié. Retourne le corps JSON typé par l'appelant. */
  async request<T>(request: PayPalRequest): Promise<T> {
    const config = this.requireConfig();
    const token = await this.getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (request.requestId) headers['PayPal-Request-Id'] = request.requestId;
    if (request.prefer) headers.Prefer = request.prefer;

    const response = await this.execute(
      `${config.baseUrl}${request.path}`,
      {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      },
      request.path,
    );

    if (response.status === 401) {
      // Jeton révoqué ou expiré côté PayPal : on purge le cache pour que la
      // tentative suivante en obtienne un neuf.
      this.invalidateToken();
      throw new PayPalApiError(401, 'UNAUTHORIZED', true);
    }

    const payload = await this.readJson(response);
    if (!response.ok) {
      throw new PayPalApiError(response.status, extractIssue(payload), isRetriableStatus(response.status));
    }
    return payload as T;
  }

  /**
   * Exécution bas niveau : timeout dur + reprises bornées sur erreurs
   * transitoires. Aucun en-tête ni corps n'est journalisé.
   */
  private async execute(url: string, init: RequestInit, operation: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= PAYPAL_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PAYPAL_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (isRetriableStatus(response.status) && attempt < PAYPAL_MAX_ATTEMPTS) {
          await delay(backoffMs(attempt));
          continue;
        }
        return response;
      } catch (error: unknown) {
        lastError = error;
        if (attempt < PAYPAL_MAX_ATTEMPTS) {
          await delay(backoffMs(attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // On ne journalise que l'opération et le type d'erreur, jamais l'URL
    // complète avec ses identifiants ni le corps.
    this.logger.error(
      `PayPal injoignable (${operation}) après ${PAYPAL_MAX_ATTEMPTS} tentatives: ${
        lastError instanceof Error ? lastError.name : 'UNKNOWN_ERROR'
      }`,
    );
    throw new ServiceUnavailableException(PAYPAL_UNAVAILABLE);
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      return {};
    }
  }
}

export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function backoffMs(attempt: number): number {
  return Math.min(2_000, 200 * 2 ** (attempt - 1));
}

/**
 * Extrait un nom d'erreur PayPal stable et NON sensible.
 * Le corps brut n'est jamais propagé : il peut contenir des détails de compte.
 */
export function extractIssue(payload: unknown): string {
  const body = payload as {
    name?: unknown;
    details?: { issue?: unknown }[];
  } | null;
  const detail = Array.isArray(body?.details) ? body?.details[0]?.issue : undefined;
  const candidate = typeof detail === 'string' ? detail : body?.name;
  return typeof candidate === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate)
    ? candidate
    : 'UNKNOWN_ISSUE';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
