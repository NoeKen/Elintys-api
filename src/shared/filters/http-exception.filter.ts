import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { RequestWithId } from '../middleware/request-observability.middleware';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const responseBody =
      exceptionResponse && typeof exceptionResponse === 'object'
        ? (exceptionResponse as { message?: string | string[]; code?: unknown })
        : undefined;
    const message =
      exception instanceof HttpException
        ? typeof exceptionResponse === 'string'
          ? exceptionResponse
          : responseBody?.message ?? exception.message
        : 'Une erreur interne est survenue.';
    const code =
      responseBody && typeof responseBody.code === 'string'
        ? responseBody.code
        : undefined;

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          event: 'http_exception',
          service: 'elintys-api',
          requestId: request.requestId,
          method: request.method,
          route: request.route?.path ?? request.path,
          status,
          errorType:
            exception instanceof Error
              ? exception.constructor.name
              : 'UnknownException',
        }),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(code ? { code } : {}),
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      // Ne jamais refléter la query string : elle peut contenir un token
      // d'invitation ou une autre donnée sensible. Le chemin suffit au debug,
      // corrélé au requestId.
      path: request.path,
    });
  }
}
