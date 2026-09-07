/** Code d'erreur MongoDB pour une violation de contrainte d'unicité. */
const DUPLICATE_KEY_CODE = 11000;

/**
 * Détecte une violation d'index unique.
 *
 * Utilisé pour traduire une course entre deux écritures concurrentes en
 * conflit métier (409) plutôt qu'en 500 : l'index est l'autorité, la
 * pré-vérification applicative n'est qu'un chemin rapide.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_CODE
  );
}
