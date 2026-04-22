import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { Response } from 'express';

const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  refresh: jest.fn(),
};

const mockResponse = (): Partial<Response> => ({
  cookie: jest.fn(),
  clearCookie: jest.fn(),
});

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /auth/register ──
  describe('register', () => {
    it('délègue à authService.register et retourne le userId', async () => {
      const dto = { fullName: 'Jean', email: 'jean@test.com', password: 'mdp123', role: 'organisateur' };
      mockAuthService.register.mockResolvedValue({ userId: 'new-id' });

      const result = await controller.register(dto as never);

      expect(mockAuthService.register).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ userId: 'new-id' });
    });
  });

  // ── POST /auth/login ──
  describe('login', () => {
    it('délègue à authService.login, définit le cookie et retourne l\'accessToken', async () => {
      const dto = { email: 'jean@test.com', password: 'mdp123' };
      const res = mockResponse();
      mockAuthService.login.mockResolvedValue({
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
      });

      const result = await controller.login(dto as never, res as Response);

      expect(mockAuthService.login).toHaveBeenCalledWith(dto);
      expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'refresh_token', expect.any(Object));
      expect(result).toEqual({ accessToken: 'access_token' });
    });
  });

  // ── POST /auth/logout ──
  describe('logout', () => {
    it('délègue à authService.logout et efface le cookie', async () => {
      const res = mockResponse();
      mockAuthService.logout.mockResolvedValue(undefined);

      await controller.logout(mockUser as never, res as Response);

      expect(mockAuthService.logout).toHaveBeenCalledWith(mockUser.sub);
      expect(res.clearCookie).toHaveBeenCalledWith('refresh_token');
    });
  });

  // ── POST /auth/refresh ──
  describe('refresh', () => {
    it('délègue à authService.refresh, renouvelle le cookie et retourne le nouvel accessToken', async () => {
      const res = mockResponse();
      mockAuthService.refresh.mockResolvedValue({
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
      });

      const result = await controller.refresh(mockUser as never, 'old_refresh_token', res as Response);

      expect(mockAuthService.refresh).toHaveBeenCalledWith(mockUser.sub, 'old_refresh_token');
      expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'new_refresh_token', expect.any(Object));
      expect(result).toEqual({ accessToken: 'new_access_token' });
    });
  });
});
