import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_UNVERIFIED_EMAIL_KEY } from '../decorators/allow-unverified-email.decorator';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let request: { method: string; headers: Record<string, string>; user?: Record<string, unknown> };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new JwtAuthGuard(reflector);
    request = { method: 'GET', headers: { authorization: 'Bearer token' } };
  });

  afterEach(() => jest.restoreAllMocks());

  const handler = jest.fn();
  const cls = jest.fn();

  const makeContext = (): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: jest.fn().mockReturnValue(handler),
      getClass: jest.fn().mockReturnValue(cls),
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  const mockSuper = (value: unknown) =>
    jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockImplementation(() => {
        request.user = { sub: 'u1', roles: [], isEmailVerified: false };
        return value as boolean;
      });

  it('autorise l\'accès aux routes marquées @Public() sans vérification JWT', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const result = guard.canActivate(makeContext());
    expect(result).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  it('délègue au guard parent AuthGuard("jwt") pour les routes protégées', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const superCanActivate = mockSuper(true);

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(superCanActivate).toHaveBeenCalled();
  });

  it('délègue au guard parent quand isPublic est undefined', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const superCanActivate = mockSuper(Promise.resolve(true));

    await guard.canActivate(makeContext());
    expect(superCanActivate).toHaveBeenCalled();
  });

  it('accepte un résultat Observable du guard parent', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    mockSuper(of(true));
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });

  it('refuse sans appliquer la règle courriel si l’authentification échoue', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    mockSuper(false);
    request.method = 'POST';
    await expect(guard.canActivate(makeContext())).resolves.toBe(false);
  });

  it('refuse une mutation authentifiée d’un compte non vérifié (EMAIL_NOT_VERIFIED)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    mockSuper(true);
    request.method = 'POST';
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('laisse passer une mutation non vérifiée sur une route @AllowUnverifiedEmail()', async () => {
    reflector.getAllAndOverride.mockImplementation((key: unknown) =>
      key === ALLOW_UNVERIFIED_EMAIL_KEY ? true : undefined,
    );
    mockSuper(true);
    request.method = 'DELETE';
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });
});
