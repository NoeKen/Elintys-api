import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';

const mockAuthService = {
  register:            jest.fn(),
  login:               jest.fn(),
  refreshFromCookie:   jest.fn(),
  logoutFromCookie:    jest.fn(),
  getMe:               jest.fn(),
  forgotPassword:      jest.fn(),
  resetPassword:       jest.fn(),
  verifyEmail:         jest.fn(),
  resendVerification:  jest.fn(),
};

const mockConfigService = {
  getOrThrow: jest.fn().mockImplementation((key: string) => {
    if (key === 'nodeEnv') return 'test';
    return 'value';
  }),
};

const mockResponse = (): Partial<Response> => ({
  cookie:      jest.fn(),
  clearCookie: jest.fn(),
});

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /auth/register ──
  describe('register', () => {
    it('délègue à authService.register, définit le cookie et retourne accessToken + user', async () => {
      const dto = { fullName: 'Jean', email: 'jean@test.com', password: 'mdp123', roles: ['organisateur'] };
      const res = mockResponse();
      mockAuthService.register.mockResolvedValue({
        accessToken:  'access_token',
        refreshToken: 'refresh_token',
        user: { _id: 'new-id', fullName: 'Jean', email: 'jean@test.com', roles: ['organisateur'], isEmailVerified: false },
      });

      const result = await controller.register(dto as never, res as Response);

      expect(mockAuthService.register).toHaveBeenCalledWith(dto);
      expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'refresh_token', expect.any(Object));
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('user');
      expect(result).not.toHaveProperty('refreshToken');
    });
  });

  // ── POST /auth/login ──
  describe('login', () => {
    it("délègue à authService.login, définit le cookie et retourne l'accessToken + user", async () => {
      const dto = { email: 'jean@test.com', password: 'mdp123' };
      const res = mockResponse();
      mockAuthService.login.mockResolvedValue({
        accessToken:  'access_token',
        refreshToken: 'refresh_token',
        user: { _id: 'user-id', fullName: 'Jean', email: 'jean@test.com', roles: ['organisateur'], isEmailVerified: false },
      });

      const result = await controller.login(dto as never, res as Response);

      expect(mockAuthService.login).toHaveBeenCalledWith(dto);
      expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'refresh_token', expect.any(Object));
      expect(result).toHaveProperty('accessToken', 'access_token');
      expect(result).toHaveProperty('user');
      expect(result).not.toHaveProperty('refreshToken');
    });
  });

  // ── POST /auth/refresh ──
  describe('refresh', () => {
    it('lit le cookie, appelle refreshFromCookie, repose le cookie et retourne le nouvel accessToken', async () => {
      const req = { cookies: { refresh_token: 'old_cookie_token' } };
      const res = mockResponse();
      mockAuthService.refreshFromCookie.mockResolvedValue({
        accessToken:     'new_access_token',
        newRefreshToken: 'new_refresh_token',
      });

      const result = await controller.refresh(req as never, res as Response);

      expect(mockAuthService.refreshFromCookie).toHaveBeenCalledWith('old_cookie_token');
      expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'new_refresh_token', expect.any(Object));
      expect(result).toEqual({ accessToken: 'new_access_token' });
    });

    it('lève UnauthorizedException si le cookie refresh_token est absent', async () => {
      const req = { cookies: {} };
      const res = mockResponse();

      await expect(controller.refresh(req as never, res as Response))
        .rejects.toThrow(UnauthorizedException);

      expect(mockAuthService.refreshFromCookie).not.toHaveBeenCalled();
    });
  });

  // ── GET /auth/me ──
  describe('getMe', () => {
    it("délègue à authService.getMe avec le sub de l'utilisateur connecté", async () => {
      const mockProfile = {
        _id: 'user-id-123',
        fullName: 'Jean Tremblay',
        email: 'jean@test.com',
        roles: ['organisateur'],
        isEmailVerified: false,
        subscriptions: [],
      };
      mockAuthService.getMe.mockResolvedValue(mockProfile);

      const result = await controller.getMe(mockUser as never);

      expect(mockAuthService.getMe).toHaveBeenCalledWith(mockUser.sub);
      expect(result).toEqual(mockProfile);
    });
  });

  // ── POST /auth/logout ──
  describe('logout', () => {
    it('révoque le token en base, efface le cookie et retourne un message de confirmation', async () => {
      const req = { cookies: { refresh_token: 'old_cookie_token' } };
      const res = mockResponse();
      mockAuthService.logoutFromCookie.mockResolvedValue(undefined);

      const result = await controller.logout(req as never, res as Response);

      expect(mockAuthService.logoutFromCookie).toHaveBeenCalledWith('old_cookie_token');
      expect(res.clearCookie).toHaveBeenCalledWith('refresh_token', { path: '/' });
      expect(result).toEqual({ message: 'Déconnecté avec succès' });
    });

    it("efface le cookie même si aucun cookie refresh_token n'est présent", async () => {
      const req = { cookies: {} };
      const res = mockResponse();
      mockAuthService.logoutFromCookie.mockResolvedValue(undefined);

      await controller.logout(req as never, res as Response);

      expect(mockAuthService.logoutFromCookie).toHaveBeenCalledWith(undefined);
      expect(res.clearCookie).toHaveBeenCalledWith('refresh_token', { path: '/' });
    });
  });

  // ── POST /auth/forgot-password ──
  describe('forgotPassword', () => {
    it('délègue à authService.forgotPassword et retourne toujours un message neutre', async () => {
      mockAuthService.forgotPassword.mockResolvedValue(undefined);

      const result = await controller.forgotPassword({ email: 'jean@test.com' });

      expect(mockAuthService.forgotPassword).toHaveBeenCalledWith('jean@test.com');
      expect(result.message).toContain('courriel');
    });
  });

  // ── POST /auth/reset-password ──
  describe('resetPassword', () => {
    it('délègue à authService.resetPassword et retourne un message de succès', async () => {
      mockAuthService.resetPassword.mockResolvedValue(undefined);

      const result = await controller.resetPassword({ token: 'abc', password: 'NvxMdp123' });

      expect(mockAuthService.resetPassword).toHaveBeenCalledWith('abc', 'NvxMdp123');
      expect(result.message).toBeDefined();
    });
  });

  // ── POST /auth/verify-email ──
  describe('verifyEmail', () => {
    it('délègue à authService.verifyEmail et retourne un message de succès', async () => {
      mockAuthService.verifyEmail.mockResolvedValue(undefined);

      const result = await controller.verifyEmail({ token: 'token123' });

      expect(mockAuthService.verifyEmail).toHaveBeenCalledWith('token123');
      expect(result.message).toBeDefined();
    });
  });

  // ── POST /auth/resend-verification ──
  describe('resendVerification', () => {
    it('délègue à authService.resendVerification et retourne toujours un message neutre', async () => {
      mockAuthService.resendVerification.mockResolvedValue(undefined);

      const result = await controller.resendVerification({ email: 'jean@test.com' });

      expect(mockAuthService.resendVerification).toHaveBeenCalledWith('jean@test.com');
      expect(result.message).toContain('courriel');
    });
  });
});
