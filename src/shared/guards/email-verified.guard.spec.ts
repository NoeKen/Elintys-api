import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EmailVerifiedGuard, EMAIL_NOT_VERIFIED_MESSAGE } from './email-verified.guard';
import {
  ALLOW_UNVERIFIED_EMAIL_KEY,
  AllowUnverifiedEmail,
} from '../decorators/allow-unverified-email.decorator';
import { ErrorCodes } from '../constants/error-codes';
import { JwtPayload } from '../decorators/current-user.decorator';

describe('EmailVerifiedGuard', () => {
  let reflector: jest.Mocked<Reflector>;
  let guard: EmailVerifiedGuard;
  const handler = jest.fn();
  const cls = jest.fn();

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as jest.Mocked<Reflector>;
    guard = new EmailVerifiedGuard(reflector);
  });

  afterEach(() => jest.clearAllMocks());

  const makeContext = (
    method: string | undefined,
    user?: Partial<JwtPayload>,
    type = 'http',
  ): ExecutionContext =>
    ({
      getType: () => type,
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
    }) as unknown as ExecutionContext;

  const unverified: Partial<JwtPayload> = { sub: 'u1', roles: ['participant'], isEmailVerified: false };
  const verified: Partial<JwtPayload> = { sub: 'u1', roles: ['participant'], isEmailVerified: true };

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])(
    'devrait laisser passer une lecture %s d’un compte non vérifié',
    (method) => {
      expect(guard.canActivate(makeContext(method, unverified))).toBe(true);
      expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
    },
  );

  it('devrait traiter une méthode absente comme une lecture', () => {
    expect(guard.canActivate(makeContext(undefined, unverified))).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'devrait refuser une mutation %s d’un compte non vérifié avec EMAIL_NOT_VERIFIED',
    (method) => {
      let thrown: unknown;
      try {
        guard.canActivate(makeContext(method, unverified));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getStatus()).toBe(403);
      expect((thrown as ForbiddenException).getResponse()).toEqual({
        code: ErrorCodes.EMAIL_NOT_VERIFIED,
        message: EMAIL_NOT_VERIFIED_MESSAGE,
      });
    },
  );

  it('devrait refuser (fail-closed) quand le statut de vérification est inconnu', () => {
    expect(() => guard.canActivate(makeContext('POST', { sub: 'u1', roles: [] }))).toThrow(
      ForbiddenException,
    );
  });

  it('devrait laisser passer une mutation d’un compte vérifié', () => {
    expect(guard.canActivate(makeContext('POST', verified))).toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it('devrait ignorer les requêtes sans utilisateur (routes publiques)', () => {
    expect(guard.canActivate(makeContext('POST', undefined))).toBe(true);
  });

  it('devrait ignorer les contextes non HTTP', () => {
    expect(guard.canActivate(makeContext('POST', unverified, 'rpc'))).toBe(true);
  });

  it('devrait respecter @AllowUnverifiedEmail() sur le handler ou le controller', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(makeContext('POST', unverified))).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ALLOW_UNVERIFIED_EMAIL_KEY, [
      handler,
      cls,
    ]);
  });

  it('le décorateur pose la métadonnée attendue', () => {
    class Target {
      @AllowUnverifiedEmail()
      route(): void {}
    }
    const realReflector = new Reflector();
    expect(realReflector.get(ALLOW_UNVERIFIED_EMAIL_KEY, Target.prototype.route)).toBe(true);
  });
});
