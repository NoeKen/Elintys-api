import { resolveCookieDomain } from './cookie-domain';

describe('resolveCookieDomain', () => {
  it('normalise un domaine parent valide', () => {
    expect(
      resolveCookieDomain(
        '  .DEV.ELINTYS.APP ',
        'https://app.dev.elintys.app',
        'dev',
      ),
    ).toBe('.dev.elintys.app');
  });

  it('accepte le domaine parent de production', () => {
    expect(
      resolveCookieDomain('.elintys.com', 'https://app.elintys.com', 'prod'),
    ).toBe('.elintys.com');
  });

  it('laisse les cookies host-only en développement local', () => {
    expect(
      resolveCookieDomain(undefined, 'http://localhost:3100', 'dev'),
    ).toBeUndefined();
  });

  it.each([
    'dev.elintys.app',
    'https://dev.elintys.app',
    '.dev.elintys.app/path',
    '.dev.elintys.app:443',
    '.*.elintys.com',
    '.localhost',
    '.127.0.0.1',
  ])('rejette le format de domaine non sécurisé %s', (domain) => {
    expect(() =>
      resolveCookieDomain(domain, 'https://app.dev.elintys.app', 'dev'),
    ).toThrow('COOKIE_DOMAIN');
  });

  it("rejette un domaine qui n'est pas parent du frontend", () => {
    expect(() =>
      resolveCookieDomain('.elintys.com', 'https://example.com', 'prod'),
    ).toThrow('parent domain');
  });

  it('rejette les faux suffixes apparentés', () => {
    expect(() =>
      resolveCookieDomain(
        '.elintys.com',
        'https://app.elintys.com.evil.test',
        'prod',
      ),
    ).toThrow('parent domain');
  });

  it('empêche le développement de partager les cookies avec la production', () => {
    expect(() =>
      resolveCookieDomain(
        '.elintys.app',
        'https://app.dev.elintys.app',
        'dev',
      ),
    ).toThrow('ELINTYS_ENV=dev');
  });

  it('empêche la production d’utiliser le domaine de développement', () => {
    expect(() =>
      resolveCookieDomain(
        '.dev.elintys.app',
        'https://app.dev.elintys.app',
        'prod',
      ),
    ).toThrow('ELINTYS_ENV=prod');
  });

  it('exige un domaine de cookie dans un environnement déployé', () => {
    expect(() =>
      resolveCookieDomain(undefined, 'https://app.dev.elintys.app', 'dev', true),
    ).toThrow('required');
  });
});
