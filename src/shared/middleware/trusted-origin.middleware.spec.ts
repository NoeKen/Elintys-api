import {
  createTrustedOriginMiddleware,
  normalizeAllowedOrigins,
} from './trusted-origin.middleware';

describe('trusted origin middleware', () => {
  it('normalise et déduplique les origines exactes', () => {
    expect(
      normalizeAllowedOrigins([
        'https://dev.elintys.com',
        'https://dev.elintys.com',
        '',
      ]),
    ).toEqual(['https://dev.elintys.com']);
  });

  it.each([
    'javascript:alert(1)',
    'https://dev.elintys.com/path',
    'https://dev.elintys.com/',
    'not-a-url',
  ])('rejette une origine configurée non exacte: %s', (origin) => {
    expect(() => normalizeAllowedOrigins([origin])).toThrow();
  });

  function run(method: string, origin?: string, authenticated = false) {
    const next = jest.fn();
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const request = {
      method,
      path: '/api/v1/events',
      requestId: 'request-id',
      cookies: authenticated ? { access_token: 'private-token' } : {},
      get: jest.fn((header: string) =>
        header.toLowerCase() === 'origin' ? origin : undefined,
      ),
    };
    const response = { status };

    createTrustedOriginMiddleware(['https://dev.elintys.com'])(
      request as never,
      response as never,
      next,
    );

    return { next, status, json };
  }

  it('autorise les lectures quelle que soit leur origine', () => {
    expect(run('GET', 'https://evil.example').next).toHaveBeenCalled();
  });

  it('autorise une écriture depuis le frontend exact', () => {
    expect(
      run('POST', 'https://dev.elintys.com').next,
    ).toHaveBeenCalled();
  });

  it('autorise les clients non navigateur sans en-tête Origin', () => {
    expect(run('PATCH').next).toHaveBeenCalled();
  });

  it('refuse une écriture authentifiée par cookie sans en-tête Origin', () => {
    const result = run('PATCH', undefined, true);

    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
  });

  it('refuse une écriture navigateur venant d’une autre origine', () => {
    const result = run('DELETE', 'https://evil.example');

    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        requestId: 'request-id',
      }),
    );
  });
});
