/**
 * Elintys deliberately uses host-only authentication cookies. Defining a
 * Domain attribute would allow the cookie to cross an environment boundary
 * through sibling or descendant subdomains.
 */
export function resolveCookieDomain(
  rawDomain: string | undefined,
): undefined {
  if (rawDomain?.trim()) {
    throw new Error(
      'COOKIE_DOMAIN must be omitted: authentication cookies are host-only.',
    );
  }

  return undefined;
}
