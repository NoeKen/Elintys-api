import { EventEmitter } from 'node:events';
import { NextFunction, Request, Response } from 'express';
import {
  createRequestObservabilityMiddleware,
  RequestWithId,
  resolveRequestId,
} from './request-observability.middleware';

describe('request observability middleware', () => {
  it('conserve un x-request-id entrant valide', () => {
    expect(resolveRequestId('web:01HR.test-42')).toBe('web:01HR.test-42');
  });

  it.each([
    '',
    'contains spaces',
    'contains\nnewline',
    'a'.repeat(129),
  ])('remplace un x-request-id absent ou invalide', (headerValue) => {
    expect(resolveRequestId(headerValue || undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('propage le request id et journalise une ligne JSON sans query string', () => {
    const logger = { log: jest.fn() };
    const middleware = createRequestObservabilityMiddleware('test', logger);
    const request = {
      baseUrl: '/api/v1',
      get: jest.fn().mockReturnValue('req_frontend-123'),
      method: 'GET',
      path: '/events',
      route: { path: '/events' },
    } as unknown as RequestWithId;
    const emitter = new EventEmitter();
    const response = Object.assign(emitter, {
      setHeader: jest.fn(),
      statusCode: 200,
    }) as unknown as Response;
    const next = jest.fn() as NextFunction;

    middleware(request, response, next);
    emitter.emit('finish');

    expect(request.requestId).toBe('req_frontend-123');
    expect(response.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      'req_frontend-123',
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledTimes(1);

    const logEntry = JSON.parse(logger.log.mock.calls[0][0] as string);
    expect(logEntry).toEqual(
      expect.objectContaining({
        event: 'http_request',
        service: 'elintys-api',
        environment: 'test',
        requestId: 'req_frontend-123',
        method: 'GET',
        route: '/api/v1/events',
        status: 200,
      }),
    );
    expect(logEntry.durationMs).toEqual(expect.any(Number));
    expect(logger.log.mock.calls[0][0]).not.toContain('?');
  });

  it('ne journalise jamais les en-têtes, cookies ou paramètres de requête', () => {
    const logger = { log: jest.fn() };
    const middleware = createRequestObservabilityMiddleware('test', logger);
    const request = {
      baseUrl: '/api/v1',
      cookies: { access_token: 'secret-jwt' },
      get: jest.fn().mockReturnValue(undefined),
      headers: { authorization: 'Bearer secret-jwt' },
      method: 'POST',
      path: '/auth/login',
      query: { email: 'person@example.com' },
      route: { path: '/auth/login' },
    } as unknown as Request;
    const emitter = new EventEmitter();
    const response = Object.assign(emitter, {
      setHeader: jest.fn(),
      statusCode: 401,
    }) as unknown as Response;

    middleware(request, response, jest.fn());
    emitter.emit('finish');

    const serializedLog = logger.log.mock.calls[0][0] as string;
    expect(serializedLog).not.toContain('secret-jwt');
    expect(serializedLog).not.toContain('person@example.com');
  });
});
