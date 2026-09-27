import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { isObservable, lastValueFrom } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { EmailVerifiedGuard } from './email-verified.guard';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly emailVerifiedGuard: EmailVerifiedGuard;

  constructor(private reflector: Reflector) {
    super();
    this.emailVerifiedGuard = new EmailVerifiedGuard(reflector);
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return this.authenticateThenEnforceEmailVerification(context);
  }

  /**
   * L'authentification Passport peuple `req.user` ; la règle « courriel non
   * vérifié = lecture seule » est appliquée juste après, dans le même guard,
   * pour ne dépendre d'aucun ordre d'enregistrement de guards globaux.
   */
  private async authenticateThenEnforceEmailVerification(
    context: ExecutionContext,
  ): Promise<boolean> {
    const result = super.canActivate(context);
    const authenticated = isObservable(result) ? await lastValueFrom(result) : await result;
    if (!authenticated) return false;
    return this.emailVerifiedGuard.canActivate(context);
  }
}
