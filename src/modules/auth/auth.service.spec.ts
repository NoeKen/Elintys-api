import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { User } from './user.schema';
import { EmailsService } from '../emails/emails.service';
import { TicketsService } from '../tickets/tickets.service';
import { Types } from 'mongoose';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('AuthService', () => {
  let service: AuthService;
  let userModel: Record<string, jest.Mock>;

  const userId = new Types.ObjectId();
  const mockUser = {
    _id: userId,
    fullName: 'Jean Tremblay',
    email: 'jean@test.com',
    password: 'hashed_password',
    roles: ['organisateur'],
    isEmailVerified: false,
    refreshToken: 'hashed_refresh_token',
  };

  beforeEach(async () => {
    userModel = {
      findOne:           jest.fn(),
      find:              jest.fn(),
      findById:          jest.fn(),
      findByIdAndUpdate: jest.fn(),
      create:            jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getModelToken(User.name), useValue: userModel },
        {
          provide: JwtService,
          useValue: {
            sign:   jest.fn().mockReturnValue('mock_token'),
            verify: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              const map: Record<string, string> = {
                'jwt.secret':            'secret',
                'jwt.expiresIn':         '15m',
                'jwt.refreshSecret':     'refresh_secret',
                'jwt.refreshExpiresIn':  '7d',
                'frontendUrl':           'http://localhost:3000',
              };
              return map[key] ?? 'value';
            }),
          },
        },
        {
          provide: EmailsService,
          useValue: {
            sendEmail:             jest.fn().mockResolvedValue(undefined),
            sendEmailVerification: jest.fn().mockResolvedValue(undefined),
            sendPasswordReset:     jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TicketsService,
          useValue: { linkGuestPurchases: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    (bcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_token');
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
  });

  afterEach(() => jest.clearAllMocks());

  // ── register ──
  describe('register', () => {
    it('crée un utilisateur et retourne accessToken + user', async () => {
      userModel.findOne.mockReturnValue(makeChainable(null));
      userModel.create.mockResolvedValue(mockUser);
      userModel.findByIdAndUpdate.mockResolvedValue({});

      const result = await service.register({
        fullName: 'Jean Tremblay',
        email: 'jean@test.com',
        password: 'motdepasse123',
        roles: ['organisateur' as never],
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe('jean@test.com');
      expect(userModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'jean@test.com' }),
      );
    });

    it('lève ConflictException si le courriel existe déjà', async () => {
      userModel.findOne.mockReturnValue(makeChainable({ _id: userId }));

      await expect(
        service.register({
          fullName: 'Jean',
          email: 'jean@test.com',
          password: 'motdepasse123',
          roles: ['organisateur' as never],
        }),
      ).rejects.toThrow(ConflictException);
      expect(userModel.create).not.toHaveBeenCalled();
    });
  });

  // ── login ──
  describe('login', () => {
    it('retourne accessToken, refreshToken et user si les identifiants sont valides', async () => {
      userModel.findOne.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      userModel.findByIdAndUpdate.mockResolvedValue({});

      const result = await service.login({ email: 'jean@test.com', password: 'motdepasse123' });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
    });

    it("lève UnauthorizedException si le courriel n'existe pas", async () => {
      userModel.findOne.mockReturnValue(makeChainable(null));

      await expect(
        service.login({ email: 'inexistant@test.com', password: 'motdepasse' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('lève UnauthorizedException si le mot de passe est incorrect', async () => {
      userModel.findOne.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ email: 'jean@test.com', password: 'mauvais_mdp' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('met à jour le refreshToken hashé en base après connexion réussie', async () => {
      userModel.findOne.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      userModel.findByIdAndUpdate.mockResolvedValue({});

      await service.login({ email: 'jean@test.com', password: 'motdepasse123' });

      expect(userModel.findByIdAndUpdate).toHaveBeenCalledWith(
        mockUser._id,
        expect.objectContaining({ refreshToken: expect.any(String) }),
      );
    });
  });

  // ── logoutFromCookie ──
  describe('logoutFromCookie', () => {
    let jwtService: { sign: jest.Mock; verify: jest.Mock };

    beforeEach(() => {
      jwtService = service['jwtService'] as unknown as { sign: jest.Mock; verify: jest.Mock };
    });

    it('nullifie le refreshToken en base si le cookie est valide', async () => {
      jwtService.verify.mockReturnValue({ sub: userId.toString(), email: 'jean@test.com', roles: [] });
      userModel.findByIdAndUpdate.mockResolvedValue({});

      await service.logoutFromCookie('valid_cookie_token');

      expect(userModel.findByIdAndUpdate).toHaveBeenCalledWith(userId.toString(), { refreshToken: null });
    });

    it("ne lève pas d'exception si le cookie est undefined", async () => {
      await expect(service.logoutFromCookie(undefined)).resolves.toBeUndefined();
      expect(userModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("ne lève pas d'exception si le JWT du cookie est invalide ou expiré", async () => {
      jwtService.verify.mockImplementation(() => { throw new Error('expired'); });

      await expect(service.logoutFromCookie('expired_token')).resolves.toBeUndefined();
      expect(userModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  // ── refreshFromCookie ──
  describe('refreshFromCookie', () => {
    let jwtService: { sign: jest.Mock; verify: jest.Mock };

    beforeEach(() => {
      jwtService = service['jwtService'] as unknown as { sign: jest.Mock; verify: jest.Mock };
    });

    it('retourne un nouvel accessToken et newRefreshToken si le cookie est valide', async () => {
      jwtService.verify.mockReturnValue({ sub: userId.toString(), email: 'jean@test.com', roles: ['organisateur'] });
      userModel.findById.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      userModel.findByIdAndUpdate.mockResolvedValue({});

      const result = await service.refreshFromCookie('valid_cookie_token');

      expect(jwtService.verify).toHaveBeenCalledWith('valid_cookie_token', expect.objectContaining({ secret: 'refresh_secret' }));
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('newRefreshToken');
    });

    it('lève UnauthorizedException si le JWT du cookie est invalide', async () => {
      jwtService.verify.mockImplementation(() => { throw new Error('invalid signature'); });

      await expect(service.refreshFromCookie('bad_token'))
        .rejects.toThrow(UnauthorizedException);
    });

    it("lève UnauthorizedException si aucun refreshToken n'est stocké en base", async () => {
      jwtService.verify.mockReturnValue({ sub: userId.toString(), email: 'jean@test.com', roles: [] });
      userModel.findById.mockReturnValue(makeChainable({ ...mockUser, refreshToken: null }));

      await expect(service.refreshFromCookie('valid_jwt_but_no_db_token'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('lève UnauthorizedException si le hash stocké ne correspond pas', async () => {
      jwtService.verify.mockReturnValue({ sub: userId.toString(), email: 'jean@test.com', roles: [] });
      userModel.findById.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.refreshFromCookie('mismatched_token'))
        .rejects.toThrow(UnauthorizedException);
    });
  });

  // ── getMe ──
  describe('getMe', () => {
    it('retourne le profil utilisateur sans les champs sensibles', async () => {
      const profile = {
        _id: userId,
        fullName: 'Jean Tremblay',
        email: 'jean@test.com',
        roles: ['organisateur'],
        isEmailVerified: false,
        subscriptions: [],
      };
      userModel.findById.mockReturnValue(makeChainable(profile));

      const result = await service.getMe(userId.toString());

      expect(result).toEqual(profile);
      expect(result).not.toHaveProperty('password');
      expect(result).not.toHaveProperty('refreshToken');
    });

    it("lève NotFoundException si l'utilisateur est introuvable", async () => {
      userModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.getMe('id-inexistant')).rejects.toThrow(NotFoundException);
    });
  });
});
