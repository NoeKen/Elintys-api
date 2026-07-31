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

    const message =
      exception instanceof HttpException
        ? (exception.getResponse() as { message?: string | string[] }).message ??
          exception.message
        : 'Une erreur interne est survenue.';

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
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
