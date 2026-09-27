import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  /**
   * Statut de vérification du courriel, relu EN BASE à chaque requête
   * authentifiée par `JwtStrategy.validate` (jamais signé dans le JWT).
   * Absent des tokens émis ; présent sur `req.user`.
   */
  isEmailVerified?: boolean;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as JwtPayload;
  },
);
