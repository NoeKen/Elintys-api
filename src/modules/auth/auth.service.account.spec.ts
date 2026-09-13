import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UserRole } from './user.schema';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

type AccountService = AuthService & {
  updateProfile(userId: string, input: { firstName: string; lastName: string }): Promise<{ fullName: string }>;
  changePassword(userId: string, input: { currentPassword: string; newPassword: string }): Promise<void>;
  updateNotificationPreferences(
    userId: string,
    input: { vendorRequestReceived?: boolean; venueResponse?: boolean },
  ): Promise<{ emailNotifications: Record<string, boolean> }>;
  addRole(userId: string, role: UserRole): Promise<{
    accessToken?: string;
    user: { roles: string[] };
  }>;
};

function chain<T>(value: T) {
  const result = {
    select: jest.fn(),
    lean: jest.fn(),
  };
  result.select.mockReturnValue(result);
  result.lean.mockResolvedValue(value);
  return result;
}

function buildService() {
  const model = {
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const jwt = {
    sign: jest.fn().mockReturnValueOnce('access-updated').mockReturnValueOnce('refresh-updated'),
  };
  const config = {
    getOrThrow: jest.fn((key: string) => ({
      'jwt.secret': 'access-secret',
      'jwt.expiresIn': '15m',
      'jwt.refreshSecret': 'refresh-secret',
      'jwt.refreshExpiresIn': '7d',
    })[key]),
  };
  const service = new AuthService(
    model as never,
    jwt as never,
    config as never,
    {} as never,
    {} as never,
  ) as AccountService;
  return { service, model, jwt };
}

const USER_ID = new Types.ObjectId().toString();
const baseUser = {
  _id: new Types.ObjectId(USER_ID),
  fullName: 'Ana Test',
  email: 'ana@example.ca',
  roles: [UserRole.PARTICIPANT],
  isEmailVerified: true,
  subscriptions: [],
  onboardingCompleted: true,
  onboardingByRole: { participant: true },
  onboardingData: {},
};

describe('AuthService — account lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-value');
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  it('met à jour uniquement le nom autorisé et retourne le profil public', async () => {
    const { service, model } = buildService();
    model.findByIdAndUpdate.mockReturnValue(chain({ ...baseUser, fullName: 'Marie Tremblay' }));

    const result = await service.updateProfile(USER_ID, {
      firstName: ' Marie ',
      lastName: ' Tremblay ',
    });

    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      { $set: { fullName: 'Marie Tremblay' } },
      { new: true, runValidators: true },
    );
    expect(result.fullName).toBe('Marie Tremblay');
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('exige le mot de passe courant avant de remplacer le hash et révoque le refresh', async () => {
    const { service, model } = buildService();
    model.findById.mockReturnValue(chain({ ...baseUser, password: 'old-hash' }));
    model.findByIdAndUpdate.mockResolvedValue(baseUser);

    await service.changePassword(USER_ID, {
      currentPassword: 'AncienSecret1!',
      newPassword: 'NouveauSecret2!',
    });

    expect(bcrypt.compare).toHaveBeenCalledWith('AncienSecret1!', 'old-hash');
    expect(bcrypt.hash).toHaveBeenCalledWith('NouveauSecret2!', 12);
    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(USER_ID, {
      password: 'hashed-value',
      refreshToken: null,
    });
  });

  it('refuse un mot de passe courant incorrect sans écrire', async () => {
    const { service, model } = buildService();
    model.findById.mockReturnValue(chain({ ...baseUser, password: 'old-hash' }));
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(service.changePassword(USER_ID, {
      currentPassword: 'FauxSecret1!',
      newPassword: 'NouveauSecret2!',
    })).rejects.toThrow(BadRequestException);
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('met à jour uniquement les préférences email explicites', async () => {
    const { service, model } = buildService();
    model.findByIdAndUpdate.mockReturnValue(chain({
      ...baseUser,
      emailNotifications: {
        vendorRequestReceived: false,
        vendorResponse: true,
        venueBookingReceived: true,
        venueResponse: false,
      },
    }));

    const result = await service.updateNotificationPreferences(USER_ID, {
      vendorRequestReceived: false,
      venueResponse: false,
    });

    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      {
        $set: {
          'emailNotifications.vendorRequestReceived': false,
          'emailNotifications.venueResponse': false,
        },
      },
      { new: true, runValidators: true },
    );
    expect(result.emailNotifications.vendorRequestReceived).toBe(false);
  });

  it('refuse une mise à jour de préférences vide sans écrire', async () => {
    const { service, model } = buildService();

    await expect(service.updateNotificationPreferences(USER_ID, {})).rejects.toThrow(
      BadRequestException,
    );
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('ajoute atomiquement un rôle métier et renouvelle le JWT d’accès', async () => {
    const { service, model } = buildService();
    model.findOneAndUpdate.mockReturnValue(chain({
      ...baseUser,
      roles: [UserRole.PARTICIPANT, UserRole.PRESTATAIRE],
    }));
    const result = await service.addRole(USER_ID, UserRole.PRESTATAIRE);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(USER_ID), roles: { $ne: UserRole.PRESTATAIRE } },
      { $addToSet: { roles: UserRole.PRESTATAIRE } },
      { new: true, runValidators: true },
    );
    expect(result.user.roles).toEqual([UserRole.PARTICIPANT, UserRole.PRESTATAIRE]);
    expect(result).toMatchObject({ accessToken: 'access-updated' });
    expect(result).not.toHaveProperty('refreshToken');
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('est idempotent si le rôle est déjà actif', async () => {
    const { service, model } = buildService();
    model.findOneAndUpdate.mockReturnValue(chain(null));
    model.findById
      .mockReturnValueOnce(chain({ ...baseUser, roles: [UserRole.PARTICIPANT, UserRole.PRESTATAIRE] }));
    model.findByIdAndUpdate.mockResolvedValue(baseUser);

    const result = await service.addRole(USER_ID, UserRole.PRESTATAIRE);

    expect(result.user.roles).toContain(UserRole.PRESTATAIRE);
    expect(result.accessToken).toBeUndefined();
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('refuse en défense en profondeur tout rôle admin ou participant', async () => {
    const { service } = buildService();

    await expect(service.addRole(USER_ID, UserRole.ADMIN)).rejects.toThrow(BadRequestException);
    await expect(service.addRole(USER_ID, UserRole.PARTICIPANT)).rejects.toThrow(BadRequestException);
  });

  it('retourne 404 lorsque le compte a disparu pendant la mutation', async () => {
    const { service, model } = buildService();
    model.findByIdAndUpdate.mockReturnValue(chain(null));

    await expect(service.updateProfile(USER_ID, {
      firstName: 'Ana',
      lastName: 'Test',
    })).rejects.toThrow(NotFoundException);
  });
});
