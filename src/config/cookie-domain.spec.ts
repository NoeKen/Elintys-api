import { resolveCookieDomain } from './cookie-domain';

describe('resolveCookieDomain', () => {
  it.each([undefined, '', '   '])(
    'conserve les cookies host-only lorsque COOKIE_DOMAIN=%p',
    (domain) => {
      expect(resolveCookieDomain(domain)).toBeUndefined();
    },
  );

  it.each([
    '.dev.elintys.com',
    '.elintys.com',
    'dev.elintys.com',
    'https://dev.elintys.com',
  ])('refuse tout attribut Domain: %s', (domain) => {
    expect(() => resolveCookieDomain(domain)).toThrow(
      'authentication cookies are host-only',
    );
  });
});
