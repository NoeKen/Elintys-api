import { NextFunction, Response } from 'express';
import { RequestWithId } from './request-observability.middleware';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function normalizeAllowedOrigins(origins: string[]): string[] {
  return [...new Set(origins.filter(Boolean).map((origin) => {
    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid configured frontend origin: ${origin}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(
        `Configured frontend origin must be an absolute HTTP(S) origin without a path: ${origin}`,
      );
    }

    return parsed.origin;
  }))];
}

/**
 * Rejects browser writes coming from an untrusted Origin. This complements
 * CORS: browsers can still submit some cross-origin requests even when their
 * response is unreadable, so CORS alone is not a CSRF defense.
 *
 * Requests without an Origin are retained for server-to-server and native
 * clients. Web browsers attach Origin to cross-origin unsafe requests.
 */
export function createTrustedOriginMiddleware(allowedOrigins: string[]) {
  const trustedOrigins = new Set(normalizeAllowedOrigins(allowedOrigins));

  return (
    request: RequestWithId,
    response: Response,
    next: NextFunction,
  ): void => {
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      next();
      return;
    }

    const origin = request.get('origin');
    if (!origin || trustedOrigins.has(origin)) {
      next();
      return;
    }

    response.status(403).json({
      statusCode: 403,
      message: 'Origine de requête non autorisée.',
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      path: request.path,
    });
  };
}
