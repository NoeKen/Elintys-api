import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

describe('AllExceptionsFilter', () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const request = {
    method: 'GET',
    path: '/events',
    requestId: 'req-123',
    route: { path: '/events' },
    url: '/events?private=value',
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ajoute le requestId aux réponses en erreur', () => {
    new AllExceptionsFilter().catch(
      new HttpException('Introuvable', HttpStatus.NOT_FOUND),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Introuvable',
        requestId: 'req-123',
      }),
    );
  });

  it("journalise les erreurs serveur sans message, query string ou données d'entrée", () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const exception = new Error(
      'Database failed for person@example.com with token secret-jwt',
    );

    new AllExceptionsFilter().catch(exception, host);

    const serializedLog = errorSpy.mock.calls[0][0] as string;
    const logEntry = JSON.parse(serializedLog);
    expect(logEntry).toEqual({
      event: 'http_exception',
      service: 'elintys-api',
      requestId: 'req-123',
      method: 'GET',
      route: '/events',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errorType: 'Error',
    });
    expect(serializedLog).not.toContain('person@example.com');
    expect(serializedLog).not.toContain('secret-jwt');
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Une erreur interne est survenue.',
        requestId: 'req-123',
      }),
    );

    errorSpy.mockRestore();
  });
});
