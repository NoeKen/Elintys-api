import { ElintysEnvironment } from './elintys-environment';

const COOKIE_DOMAIN_PATTERN =
  /^\.(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function getFrontendHostname(frontendUrl: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(frontendUrl);
  } catch {
    throw new Error('FRONTEND_URL must be an absolute HTTP(S) URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('FRONTEND_URL must use HTTP or HTTPS.');
  }

  return parsedUrl.hostname.toLowerCase();
}

/**
 * Validates and normalizes the optional parent domain used by authentication
 * cookies. A leading dot is required intentionally so a host-only typo cannot
 * silently break sessions between the app and API sibling subdomains.
 */
export function resolveCookieDomain(
  rawDomain: string | undefined,
  frontendUrl: string,
  environment: ElintysEnvironment,
  requireDomain = false,
): string | undefined {
  const trimmedDomain = rawDomain?.trim();

  if (!trimmedDomain) {
    if (requireDomain) {
      throw new Error(
        'COOKIE_DOMAIN is required for a deployed environment.',
      );
    }

    return undefined;
  }

  const domain = trimmedDomain.toLowerCase();

  if (!COOKIE_DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      'COOKIE_DOMAIN must be a parent DNS domain with a leading dot (for example .dev.elintys.app).',
    );
  }

  const frontendHostname = getFrontendHostname(frontendUrl);
  const bareDomain = domain.slice(1);
  const isRelatedDomain =
    frontendHostname === bareDomain || frontendHostname.endsWith(domain);

  if (!isRelatedDomain) {
    throw new Error(
      'COOKIE_DOMAIN must be a parent domain of the FRONTEND_URL hostname.',
    );
  }

  const expectedDomain =
    environment === 'dev' ? '.dev.elintys.app' : '.elintys.com';

  if (domain !== expectedDomain) {
    throw new Error(
      `COOKIE_DOMAIN must be ${expectedDomain} when ELINTYS_ENV=${environment}.`,
    );
  }

  return domain;
}
