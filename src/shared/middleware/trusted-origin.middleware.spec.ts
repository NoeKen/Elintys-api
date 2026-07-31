import {
  createTrustedOriginMiddleware,
  normalizeAllowedOrigins,
} from './trusted-origin.middleware';

describe('trusted origin middleware', () => {
  it('normalise et déduplique les origines exactes', () => {
    expect(
      normalizeAllowedOrigins([
        'https://app.dev.elintys.app',
        'https://app.dev.elintys.app',
        '',
      ]),
    ).toEqual(['https://app.dev.elintys.app']);
  });

  it.each([
    'javascript:alert(1)',
    'https://app.dev.elintys.app/path',
    'https://app.dev.elintys.app/',
    'not-a-url',
  ])('rejette une origine configurée non exacte: %s', (origin) => {
    expect(() => normalizeAllowedOrigins([origin])).toThrow();
  });

  function run(method: string, origin?: string) {
    const next = jest.fn();
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const request = {
      method,
      path: '/api/v1/events',
      requestId: 'request-id',
      get: jest.fn((header: string) =>
        header.toLowerCase() === 'origin' ? origin : undefined,
      ),
    };
    const response = { status };

    createTrustedOriginMiddleware(['https://app.dev.elintys.app'])(
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
      run('POST', 'https://app.dev.elintys.app').next,
    ).toHaveBeenCalled();
  });

  it('autorise les clients non navigateur sans en-tête Origin', () => {
    expect(run('PATCH').next).toHaveBeenCalled();
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
