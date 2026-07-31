import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RequestWithId extends Request {
  requestId?: string;
}

export interface StructuredLogger {
  log(message: string): void;
}

export function resolveRequestId(headerValue: string | undefined): string {
  return headerValue && REQUEST_ID_PATTERN.test(headerValue)
    ? headerValue
    : randomUUID();
}

function resolveRoute(request: Request): string {
  const matchedPath =
    typeof request.route?.path === 'string' ? request.route.path : request.path;

  return `${request.baseUrl ?? ''}${matchedPath || '/'}`;
}

export function createRequestObservabilityMiddleware(
  environment: string,
  logger: StructuredLogger = new Logger('HttpObservability'),
) {
  return (
    request: RequestWithId,
    response: Response,
    next: NextFunction,
  ): void => {
    const startedAt = process.hrtime.bigint();
    const requestId = resolveRequestId(request.get('x-request-id'));

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    response.once('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      logger.log(
        JSON.stringify({
          event: 'http_request',
          service: 'elintys-api',
          environment,
          requestId,
          method: request.method,
          route: resolveRoute(request),
          status: response.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        }),
      );
    });

    next();
  };
}
