import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { User } from './user.schema';
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
    refreshToken: 'hashed_refresh_token',
  };

  beforeEach(async () => {
    userModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      create: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getModelToken(User.name), useValue: userModel },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('mock_token') },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              const map: Record<string, string> = {
                'jwt.secret': 'secret',
                'jwt.expiresIn': '15m',
                'jwt.refreshSecret': 'refresh_secret',
                'jwt.refreshExpiresIn': '7d',
              };
              return map[key] ?? 'value';
            }),
          },
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
    it('crée un utilisateur et retourne son userId', async () => {
      userModel.findOne.mockReturnValue(makeChainable(null));
      userModel.create.mockResolvedValue({ _id: userId });

      const result = await service.register({
        fullName: 'Jean Tremblay',
        email: 'jean@test.com',
        password: 'motdepasse123',
        role: 'organisateur' as never,
      });

      expect(result).toEqual({ userId: userId.toString() });
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
          role: 'organisateur' as never,
        }),
      ).rejects.toThrow(ConflictException);
      expect(userModel.create).not.toHaveBeenCalled();
    });
  });

  // ── login ──
  describe('login', () => {
    it('retourne accessToken et refreshToken si les identifiants sont valides', async () => {
      userModel.findOne.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      userModel.findByIdAndUpdate.mockResolvedValue({});

      const result = await service.login({ email: 'jean@test.com', password: 'motdepasse123' });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    it('lève UnauthorizedException si le courriel n\'existe pas', async () => {
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

  // ── refresh ──
  describe('refresh', () => {
    it('retourne un nouveau TokenPair si le refreshToken est valide', async () => {
      userModel.findById.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      userModel.findByIdAndUpdate.mockResolvedValue({});

      const result = await service.refresh(userId.toString(), 'incoming_refresh_token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    it('lève UnauthorizedException si aucun refreshToken n\'est stocké', async () => {
      userModel.findById.mockReturnValue(makeChainable({ ...mockUser, refreshToken: null }));

      await expect(
        service.refresh(userId.toString(), 'token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('lève UnauthorizedException si le refreshToken ne correspond pas', async () => {
      userModel.findById.mockReturnValue(makeChainable(mockUser));
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.refresh(userId.toString(), 'mauvais_token'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── logout ──
  describe('logout', () => {
    it('invalide le refreshToken en base', async () => {
      userModel.findById.mockReturnValue(makeChainable({ _id: userId }));
      userModel.findByIdAndUpdate.mockResolvedValue({});

      await service.logout(userId.toString());

      expect(userModel.findByIdAndUpdate).toHaveBeenCalledWith(
        userId.toString(),
        { $unset: { refreshToken: 1 } },
      );
    });

    it('lève NotFoundException si l\'utilisateur n\'existe pas', async () => {
      userModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.logout('id-inexistant')).rejects.toThrow(NotFoundException);
    });
  });
});
