/**
 * Tiers de rate-limiting centralisés (findings F-002 & F-019).
 *
 * Stratégie : le throttler global `default` applique le tier PUBLIC_READ
 * (généreux) à TOUTES les routes — la zone publique n'est donc plus saturée
 * de 429 sous faible charge (F-019). Les endpoints sensibles surchargent
 * localement ce tier via `@Throttle({ default: TIER })` pour appliquer une
 * limite stricte anti-brute-force (F-002).
 *
 * Les valeurs sont volontairement centralisées ici pour être auditées et
 * ajustées après mesure (load-test) sans toucher aux contrôleurs.
 */
export const THROTTLE_TIERS = {
  /** Lectures publiques (catalogue) — large. */
  PUBLIC_READ: { ttl: 60_000, limit: 300 },
  /** Authentification sensible (login, reset, verify) — strict. */
  AUTH_STRICT: { ttl: 60_000, limit: 5 },
  /** Récupération de mot de passe — strict sur fenêtre longue. */
  FORGOT_PASSWORD: { ttl: 15 * 60_000, limit: 5 },
  /** Vérification de code d'accès événement — anti-brute-force. */
  ACCESS_CODE: { ttl: 60_000, limit: 10 },
  /** Acceptation d'invitation par token — anti-brute-force. */
  INVITATION_ACCEPT: { ttl: 60_000, limit: 10 },
} as const;
