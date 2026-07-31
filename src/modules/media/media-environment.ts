import type { ElintysEnvironment } from '../../config/elintys-environment';

export function getMediaRootPrefix(
  environment: ElintysEnvironment | undefined,
): string {
  if (environment !== 'dev' && environment !== 'prod') {
    throw new Error('MEDIA_ENVIRONMENT_INVALID');
  }
  return `Elintys/${environment}`;
}
