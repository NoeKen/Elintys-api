import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role, ROLES_KEY } from '../decorators/roles.decorator';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  const handler = jest.fn();
  const cls = jest.fn();

  const makeContext = (userRoles: string[]): ExecutionContext =>
    ({
      getHandler: jest.fn().mockReturnValue(handler),
      getClass: jest.fn().mockReturnValue(cls),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: 'user-id', email: 'test@test.com', roles: userRoles },
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() } as unknown as jest.Mocked<Reflector>;
    guard = new RolesGuard(reflector);
  });

  afterEach(() => jest.clearAllMocks());

  it('autorise si aucun rôle requis (metadata absente)', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(makeContext([Role.PARTICIPANT]))).toBe(true);
  });

  it('autorise si le tableau de rôles requis est vide', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(guard.canActivate(makeContext([Role.PARTICIPANT]))).toBe(true);
  });

  it('autorise si l\'utilisateur possède un des rôles requis', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ORGANISATEUR, Role.ADMIN]);
    expect(guard.canActivate(makeContext([Role.ORGANISATEUR]))).toBe(true);
  });

  it('autorise si l\'utilisateur est admin et que organisateur est requis', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ORGANISATEUR, Role.ADMIN]);
    expect(guard.canActivate(makeContext([Role.ADMIN]))).toBe(true);
  });

  it('lève ForbiddenException si le rôle de l\'utilisateur ne correspond pas', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() => guard.canActivate(makeContext([Role.PARTICIPANT]))).toThrow(ForbiddenException);
  });

  it('lève ForbiddenException si l\'utilisateur n\'a aucun rôle', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ORGANISATEUR]);
    expect(() => guard.canActivate(makeContext([]))).toThrow(ForbiddenException);
  });

  it('vérifie la clé ROLES_KEY dans le reflector', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ORGANISATEUR]);
    guard.canActivate(makeContext([Role.ORGANISATEUR]));
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
