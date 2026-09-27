/**
 * Sémantique UNIQUE des drapeaux booléens d'environnement, partagée par
 * `configuration.ts` (exécution) et `env.validation.ts` (démarrage).
 *
 * Seules les valeurs canoniques `true` / `false` (minuscules, sans espaces)
 * sont reconnues : la validation refuse toute variante (`FALSE`, ` false`…)
 * pour qu'aucune valeur ne soit comprise différemment au démarrage et à
 * l'exécution.
 */
export const ENV_FLAG_VALUES = ['true', 'false'] as const;

/** Drapeau « opt-in » : actif uniquement si la valeur vaut exactement `true`. */
export function isOptInFlagEnabled(raw: unknown): boolean {
  return raw === 'true';
}

/** Drapeau « opt-out » : actif sauf si la valeur vaut exactement `false`. */
export function isOptOutFlagEnabled(raw: unknown): boolean {
  return raw !== 'false';
}
