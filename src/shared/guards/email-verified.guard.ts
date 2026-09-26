import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCodes } from '../constants/error-codes';
import { JwtPayload } from '../decorators/current-user.decorator';
import { ALLOW_UNVERIFIED_EMAIL_KEY } from '../decorators/allow-unverified-email.decorator';

/** Méthodes HTTP sans effet de bord métier. Tout le reste est considéré mutant. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Veuillez vérifier votre adresse courriel avant d’effectuer cette action.';

/**
 * Règle produit « courriel non vérifié = lecture seule », appliquée côté serveur.
 *
 * Ce guard n'est PAS enregistré seul : il est invoqué par `JwtAuthGuard`
 * immédiatement APRÈS l'authentification, ce qui garantit que `req.user` est
 * peuplé (les guards globaux `APP_GUARD` s'exécutent avant les guards de
 * controller et ne verraient pas l'utilisateur). Toute route authentifiée
 * est donc couverte sans dépendre de l'ordre d'enregistrement des guards.
 *
 * `req.user.isEmailVerified` est lu en base par `JwtStrategy.validate` (même
 * requête que la vérification d'existence du compte : aucun aller-retour
 * supplémentaire) — jamais depuis le JWT, qui serait périmé après vérification.
 *
 * Fail-closed : seul `isEmailVerified === true` laisse passer une mutation.
 * Les routes `@Public()` (sans utilisateur) ne sont pas concernées.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context
      .switchToHttp()
      .getRequest<{ method?: string; user?: JwtPayload }>();

    if (READ_ONLY_METHODS.has((request.method ?? 'GET').toUpperCase())) return true;
    if (!request.user) return true;
    if (request.user.isEmailVerified === true) return true;

    const allowUnverified = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNVERIFIED_EMAIL_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowUnverified) return true;

    throw new ForbiddenException({
      code: ErrorCodes.EMAIL_NOT_VERIFIED,
      message: EMAIL_NOT_VERIFIED_MESSAGE,
    });
  }
}
