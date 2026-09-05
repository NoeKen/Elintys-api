/**
 * Résolution de la configuration PayPal (Vague 6 — Sandbox uniquement).
 *
 * Trois principes :
 *
 * 1. FAIL-CLOSED — toute configuration incomplète ou incohérente empêche le
 *    démarrage plutôt que de laisser l'API tourner « à moitié branchée » sur
 *    un fournisseur de paiement.
 *
 * 2. SANDBOX SEULEMENT — `PAYPAL_ENV=live` est REFUSÉ dans tous les
 *    environnements pendant la Vague 6. Aucun endpoint de paiement réel ne
 *    peut être sélectionné par configuration.
 *
 * 3. AUCUN SECRET EN CLAIR — ce module ne journalise jamais `clientSecret` ni
 *    `webhookId`. Les messages d'erreur ne citent que des NOMS de variables.
 */

export type PayPalEnvironment = 'sandbox';

/** Hôtes officiels de l'API PayPal REST (Orders v2). */
export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export interface PayPalConfig {
  /** Le fournisseur PayPal peut-il être sélectionné ? */
  enabled: boolean;
  environment: PayPalEnvironment;
  /** Hôte API dérivé de `environment` — jamais fourni directement par l'opérateur. */
  baseUrl: string;
  clientId: string | null;
  clientSecret: string | null;
  /** Identifiant du webhook PayPal, requis par l'API de vérification de signature. */
  webhookId: string | null;
}

export const PAYPAL_DISABLED: PayPalConfig = Object.freeze({
  enabled: false,
  environment: 'sandbox',
  baseUrl: PAYPAL_SANDBOX_BASE_URL,
  clientId: null,
  clientSecret: null,
  webhookId: null,
});

function parseEnvironment(raw: string | undefined): PayPalEnvironment {
  const value = (raw ?? 'sandbox').trim().toLowerCase();
  if (value === 'sandbox') return value;
  if (value === 'live') {
    throw new Error('PAYPAL_ENV=live is disabled: Sprint 3 Wave 6 is sandbox-only.');
  }
  throw new Error("PAYPAL_ENV must be 'sandbox'.");
}

/**
 * @param raw          variables brutes (jamais journalisées)
 * @param elintysEnv   'dev' | 'prod'
 * @param nodeEnv      NODE_ENV
 */
export function resolvePayPalConfig(
  raw: {
    enabled: string | undefined;
    environment: string | undefined;
    clientId: string | undefined;
    clientSecret: string | undefined;
    webhookId: string | undefined;
  },
  _elintysEnv: string,
  _nodeEnv: string,
): PayPalConfig {
  const environment = parseEnvironment(raw.environment);

  const enabled = raw.enabled === 'true';
  if (!enabled) return PAYPAL_DISABLED;

  // Garde n°2 — activation sans credentials complètes : refus de démarrage.
  const missing = (
    [
      ['PAYPAL_CLIENT_ID', raw.clientId],
      ['PAYPAL_CLIENT_SECRET', raw.clientSecret],
      ['PAYPAL_WEBHOOK_ID', raw.webhookId],
    ] as const
  )
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `PAYPAL_PROVIDER_ENABLED=true requires ${missing.join(', ')} to be set.`,
    );
  }

  return {
    enabled: true,
    environment,
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    clientId: raw.clientId!.trim(),
    clientSecret: raw.clientSecret!.trim(),
    webhookId: raw.webhookId!.trim(),
  };
}

/**
 * Projection sûre pour journalisation et diagnostic.
 * Ne contient AUCUN secret : uniquement des drapeaux de présence.
 */
export function describePayPalConfig(config: PayPalConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    environment: config.environment,
    baseUrl: config.baseUrl,
    clientIdPresent: Boolean(config.clientId),
    clientSecretPresent: Boolean(config.clientSecret),
    webhookIdPresent: Boolean(config.webhookId),
  };
}
