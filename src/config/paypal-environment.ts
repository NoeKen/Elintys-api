/**
 * Configuration PayPal — SOURCE DE VÉRITÉ UNIQUE.
 *
 * Quatre principes :
 *
 * 1. PILOTÉE PAR CONFIGURATION — passer de Sandbox à Live ne demande AUCUNE
 *    modification de code : seules les variables d'environnement changent.
 *    Aucun autre fichier ne doit contenir d'URL PayPal ni de test
 *    `environment === 'sandbox'`.
 *
 * 2. FAIL-CLOSED — toute configuration incomplète ou incohérente empêche le
 *    démarrage plutôt que de laisser l'API tourner « à moitié branchée » sur un
 *    fournisseur de paiement. Il n'existe AUCUN repli silencieux : ni
 *    live → sandbox, ni sandbox → live.
 *
 * 3. INDÉPENDANTE DE NODE_ENV — `PAYPAL_ENV` et `NODE_ENV` sont deux dimensions
 *    distinctes. Un build de production peut viser Sandbox ; un environnement
 *    de développement ne bascule jamais en Live tout seul. Aucune dérivation de
 *    l'un vers l'autre n'est faite ici, volontairement.
 *
 * 4. AUCUN SECRET EN CLAIR — ce module ne journalise jamais `clientSecret` ni
 *    `webhookId`. Les messages d'erreur ne citent que des NOMS de variables.
 */

export const PAYPAL_ENVIRONMENTS = ['sandbox', 'live'] as const;
export type PayPalEnvironment = (typeof PAYPAL_ENVIRONMENTS)[number];

/**
 * Hôtes officiels de l'API PayPal REST (Orders v2) et hôtes d'approbation
 * acheteur, par environnement.
 *
 * C'est le SEUL endroit du dépôt où ces valeurs apparaissent. OAuth, Orders,
 * Capture et vérification de webhook les consomment via `config.baseUrl`.
 */
const PAYPAL_ENDPOINTS: Record<
  PayPalEnvironment,
  { baseUrl: string; approvalHosts: readonly string[] }
> = {
  sandbox: {
    baseUrl: 'https://api-m.sandbox.paypal.com',
    approvalHosts: ['sandbox.paypal.com', 'www.sandbox.paypal.com'],
  },
  live: {
    baseUrl: 'https://api-m.paypal.com',
    approvalHosts: ['paypal.com', 'www.paypal.com'],
  },
};

export interface PayPalConfig {
  /** Le fournisseur PayPal peut-il être sélectionné ? */
  enabled: boolean;
  environment: PayPalEnvironment;
  /** Hôte API dérivé de `environment` — jamais fourni directement par l'opérateur. */
  baseUrl: string;
  /**
   * Hôtes autorisés pour l'URL d'approbation acheteur, dérivés de
   * `environment`. Une URL d'approbation Live est refusée en Sandbox et
   * réciproquement : une confusion d'environnement est un incident, pas un
   * détail cosmétique.
   */
  approvalHosts: readonly string[];
  clientId: string | null;
  clientSecret: string | null;
  /** Identifiant du webhook PayPal, requis par l'API de vérification de signature. */
  webhookId: string | null;
}

export const PAYPAL_DISABLED: PayPalConfig = Object.freeze({
  enabled: false,
  environment: 'sandbox',
  baseUrl: PAYPAL_ENDPOINTS.sandbox.baseUrl,
  approvalHosts: PAYPAL_ENDPOINTS.sandbox.approvalHosts,
  clientId: null,
  clientSecret: null,
  webhookId: null,
});

export function isPayPalEnvironment(value: string): value is PayPalEnvironment {
  return (PAYPAL_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * `PAYPAL_ENV` absent ⇒ `sandbox`.
 *
 * Le défaut penche volontairement vers l'environnement INOFFENSIF : une
 * variable oubliée ne doit jamais aboutir à des paiements réels.
 */
function parseEnvironment(raw: string | undefined): PayPalEnvironment {
  const value = (raw ?? 'sandbox').trim().toLowerCase();
  if (isPayPalEnvironment(value)) return value;
  throw new Error(`PAYPAL_ENV must be one of: ${PAYPAL_ENVIRONMENTS.join(', ')}.`);
}

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
  // L'environnement est validé MÊME quand le fournisseur est désactivé : une
  // valeur invalide est une erreur d'exploitation, pas une option ignorable.
  const environment = parseEnvironment(raw.environment);
  const endpoints = PAYPAL_ENDPOINTS[environment];

  const enabled = raw.enabled === 'true';
  if (!enabled) return PAYPAL_DISABLED;

  // Activation sans credentials complètes : refus de démarrage.
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
    baseUrl: endpoints.baseUrl,
    approvalHosts: endpoints.approvalHosts,
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
    approvalHosts: [...config.approvalHosts],
    clientIdPresent: Boolean(config.clientId),
    clientSecretPresent: Boolean(config.clientSecret),
    webhookIdPresent: Boolean(config.webhookId),
  };
}
