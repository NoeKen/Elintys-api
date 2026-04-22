import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new JwtAuthGuard(reflector);
  });

  afterEach(() => jest.clearAllMocks());

  const handler = jest.fn();
  const cls = jest.fn();

  const makeContext = (): ExecutionContext =>
    ({
      getHandler: jest.fn().mockReturnValue(handler),
      getClass: jest.fn().mockReturnValue(cls),
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: 'Bearer token' } }),
      }),
    }) as unknown as ExecutionContext;

  it('autorise l\'accès aux routes marquées @Public() sans vérification JWT', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const result = guard.canActivate(makeContext());
    expect(result).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  it('délègue au guard parent AuthGuard("jwt") pour les routes protégées', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const superCanActivate = jest.spyOn(
      Object.getPrototypeOf(JwtAuthGuard.prototype),
      'canActivate',
    ).mockReturnValue(true);

    const result = guard.canActivate(makeContext());
    expect(result).toBe(true);
    expect(superCanActivate).toHaveBeenCalled();
    superCanActivate.mockRestore();
  });

  it('délègue au guard parent quand isPublic est undefined', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const superCanActivate = jest.spyOn(
      Object.getPrototypeOf(JwtAuthGuard.prototype),
      'canActivate',
    ).mockReturnValue(true);

    guard.canActivate(makeContext());
    expect(superCanActivate).toHaveBeenCalled();
    superCanActivate.mockRestore();
  });
});
