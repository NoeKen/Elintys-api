export type ElintysEnvironment = 'dev' | 'prod';

export function resolveElintysEnvironment(
  rawEnvironment: string | undefined,
  nodeEnv: string,
): ElintysEnvironment {
  if (rawEnvironment === 'dev' || rawEnvironment === 'prod') {
    return rawEnvironment;
  }

  if (!rawEnvironment && (nodeEnv === 'development' || nodeEnv === 'test')) {
    return 'dev';
  }

  throw new Error(
    'ELINTYS_ENV must be explicitly set to "dev" or "prod" for a deployed environment.',
  );
}
