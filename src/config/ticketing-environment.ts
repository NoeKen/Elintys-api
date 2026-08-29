/**
 * Résolution de la configuration Ticketing payant (Vague 5).
 *
 * Deux garde-fous distincts :
 *
 * 1. `PAID_TICKET_HOLD_MINUTES` — durée de la réservation temporaire de stock.
 *    Valeur unique, jamais dupliquée dans les services.
 *
 * 2. `TEST_PAYMENT_PROVIDER_ENABLED` — fournisseur de paiement simulé.
 *    Ce fournisseur permet de faire passer une commande à l'état PAID sans
 *    paiement réel. Il est donc traité comme un interrupteur de sécurité :
 *    l'application REFUSE DE DÉMARRER s'il est demandé hors d'un environnement
 *    autorisé, plutôt que de démarrer silencieusement avec un contournement
 *    de paiement actif.
 */

/** Valeur DEV. N'est pas une décision commerciale : à confirmer par le produit. */
export const DEFAULT_PAID_TICKET_HOLD_MINUTES = 15;
export const MIN_PAID_TICKET_HOLD_MINUTES = 1;
export const MAX_PAID_TICKET_HOLD_MINUTES = 120;

export function resolvePaidTicketHoldMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PAID_TICKET_HOLD_MINUTES;
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(
      'PAID_TICKET_HOLD_MINUTES must be a positive integer number of minutes.',
    );
  }
  const minutes = Number(raw.trim());
  if (minutes < MIN_PAID_TICKET_HOLD_MINUTES || minutes > MAX_PAID_TICKET_HOLD_MINUTES) {
    throw new Error(
      `PAID_TICKET_HOLD_MINUTES must be between ${MIN_PAID_TICKET_HOLD_MINUTES} and ${MAX_PAID_TICKET_HOLD_MINUTES} minutes.`,
    );
  }
  return minutes;
}

/**
 * Le fournisseur simulé n'est autorisé que si TOUTES ces conditions sont vraies :
 *   - `TEST_PAYMENT_PROVIDER_ENABLED === 'true'` (opt-in explicite)
 *   - `ELINTYS_ENV === 'dev'`
 *   - `NODE_ENV !== 'production'`
 *
 * Toute demande d'activation dans un environnement non autorisé lève une erreur
 * au chargement de la configuration : impossible d'activer accidentellement en
 * production, et impossible de démarrer « à moitié activé ».
 */
export function resolveTestPaymentProviderEnabled(
  raw: string | undefined,
  elintysEnv: string,
  nodeEnv: string,
): boolean {
  const requested = raw === 'true';
  if (!requested) return false;

  if (elintysEnv !== 'dev' || nodeEnv === 'production') {
    throw new Error(
      'TEST_PAYMENT_PROVIDER_ENABLED is only allowed when ELINTYS_ENV=dev and NODE_ENV is not production.',
    );
  }
  return true;
}
