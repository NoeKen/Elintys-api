/**
 * Environnement Elintys — dimension distincte de NODE_ENV.
 *
 * - `local` : poste développeur (défaut quand ELINTYS_ENV est absent hors production)
 * - `ci`    : exécution d'intégration continue (base éphémère, jamais Atlas)
 * - `dev`   : déploiement Render `elintys-api-dev` (base `elintys-dev`)
 * - `uat`   : recette utilisateur (base `elintys-uat`, PayPal sandbox uniquement)
 * - `prod`  : production
 *
 * NODE_ENV=production (build optimisé, cookies Secure) est utilisé par dev,
 * uat ET prod : il ne permet donc jamais, seul, de savoir où l'on est.
 */
export const ELINTYS_ENVIRONMENTS = ['local', 'ci', 'dev', 'uat', 'prod'] as const;
export type ElintysEnvironment = (typeof ELINTYS_ENVIRONMENTS)[number];

/** Environnements exposés à de vrais utilisateurs : validation stricte. */
export const STRICT_ELINTYS_ENVIRONMENTS: readonly ElintysEnvironment[] = ['uat', 'prod'];

export function isElintysEnvironment(value: unknown): value is ElintysEnvironment {
  return typeof value === 'string' && (ELINTYS_ENVIRONMENTS as readonly string[]).includes(value);
}

export function isStrictElintysEnvironment(environment: ElintysEnvironment): boolean {
  return STRICT_ELINTYS_ENVIRONMENTS.includes(environment);
}

export function resolveElintysEnvironment(
  rawEnvironment: string | undefined,
  nodeEnv: string,
): ElintysEnvironment {
  const value = rawEnvironment?.trim();
  if (value) {
    if (isElintysEnvironment(value)) return value;
    throw new Error(`ELINTYS_ENV must be one of: ${ELINTYS_ENVIRONMENTS.join(', ')}.`);
  }

  // Absent : toléré uniquement sur un poste de développement ou en test.
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return 'local';
  }

  throw new Error(
    `ELINTYS_ENV is required when NODE_ENV=${nodeEnv} (one of: ${ELINTYS_ENVIRONMENTS.join(', ')}).`,
  );
}
