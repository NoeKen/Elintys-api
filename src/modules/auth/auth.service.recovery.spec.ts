import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { ErrorCodes } from '../../shared/constants/error-codes';

/**
 * Couverture des parcours de récupération de compte (finding F-013 — priorité « Auth ») :
 * mot de passe oublié, réinitialisation, vérification de courriel, renvoi de vérification.
 */

interface UserModelStub {
  findOne?: jest.Mock;
  find?: jest.Mock;
  findByIdAndUpdate?: jest.Mock;
}

function makeService(userModel: UserModelStub, emails: Record<string, jest.Mock> = {}) {
  const emailsService = {
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendEmailVerification: jest.fn().mockResolvedValue(undefined),
    ...emails,
  };
  const service = new AuthService(
    userModel as never,
    { signAsync: jest.fn().mockResolvedValue('jwt') } as never,
    { getOrThrow: jest.fn().mockReturnValue('secret'), get: jest.fn() } as never,
    emailsService as never,
    { attachGuestPurchases: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, emailsService };
}

/** .findOne().select().lean() → valeur */
function findOneChain(value: unknown) {
  return jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }),
  });
}
/** .find().select().lean() → tableau */
function findChain(values: unknown[]) {
  return jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(values) }),
  });
}

describe('AuthService — forgotPassword', () => {
  it('devrait rester silencieux pour un courriel inconnu (anti-énumération)', async () => {
    const findByIdAndUpdate = jest.fn();
    const { service, emailsService } = makeService({
      findOne: findOneChain(null),
      findByIdAndUpdate,
    });
    await expect(service.forgotPassword('inconnu@example.ca')).resolves.toBeUndefined();
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
    expect(emailsService.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('devrait stocker un jeton hashé et envoyer le courriel', async () => {
    const userId = new Types.ObjectId();
    const findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    const { service, emailsService } = makeService({
      findOne: findOneChain({ _id: userId, email: 'marie@elintys.ca', fullName: 'Marie' }),
      findByIdAndUpdate,
    });

    await service.forgotPassword('marie@elintys.ca');

    const [, update] = findByIdAndUpdate.mock.calls[0];
    // Le jeton envoyé par courriel est le jeton BRUT ; la base ne stocke qu'un hash.
    const sentToken = emailsService.sendPasswordReset.mock.calls[0][1].token as string;
    expect(update.passwordResetToken).not.toBe(sentToken);
    await expect(bcrypt.compare(sentToken, update.passwordResetToken as string)).resolves.toBe(true);
    expect(update.passwordResetExpires.getTime()).toBeGreaterThan(Date.now());
  });

  it('devrait absorber un échec d’envoi de courriel (neutralité de sécurité)', async () => {
    const { service } = makeService(
      {
        findOne: findOneChain({ _id: new Types.ObjectId(), email: 'a@b.ca', fullName: 'A' }),
        findByIdAndUpdate: jest.fn().mockResolvedValue(null),
      },
      { sendPasswordReset: jest.fn().mockRejectedValue(new Error('SMTP down')) },
    );
    await expect(service.forgotPassword('a@b.ca')).resolves.toBeUndefined();
  });
});

describe('AuthService — resetPassword', () => {
  it('devrait refuser si aucun jeton non expiré ne correspond', async () => {
    const { service } = makeService({ find: findChain([]) });
    await expect(service.resetPassword('jeton', 'NouveauMdp1!')).rejects.toThrow(
      new BadRequestException(ErrorCodes.INVALID_RESET_TOKEN),
    );
  });

  it('devrait ignorer les utilisateurs sans jeton stocké', async () => {
    const { service } = makeService({
      find: findChain([{ _id: new Types.ObjectId(), passwordResetToken: null }]),
    });
    await expect(service.resetPassword('jeton', 'NouveauMdp1!')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('devrait refuser un jeton qui ne correspond à aucun hash', async () => {
    const autreHash = await bcrypt.hash('autre-jeton', 4);
    const { service } = makeService({
      find: findChain([{ _id: new Types.ObjectId(), passwordResetToken: autreHash }]),
    });
    await expect(service.resetPassword('mon-jeton', 'NouveauMdp1!')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('devrait réinitialiser le mot de passe et invalider les sessions', async () => {
    const userId = new Types.ObjectId();
    const hash = await bcrypt.hash('bon-jeton', 4);
    const findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    const { service } = makeService({
      find: findChain([
        { _id: new Types.ObjectId(), passwordResetToken: await bcrypt.hash('autre', 4) },
        { _id: userId, passwordResetToken: hash },
      ]),
      findByIdAndUpdate,
    });

    await service.resetPassword('bon-jeton', 'NouveauMdp1!');

    const [id, update] = findByIdAndUpdate.mock.calls[0];
    expect(id).toBe(userId);
    expect(update.passwordResetToken).toBeNull();
    expect(update.passwordResetExpires).toBeNull();
    // Les sessions existantes doivent être révoquées.
    expect(update.refreshToken).toBeNull();
    // Le mot de passe est stocké hashé, jamais en clair.
    expect(update.password).not.toBe('NouveauMdp1!');
    await expect(bcrypt.compare('NouveauMdp1!', update.password as string)).resolves.toBe(true);
  });
});

describe('AuthService — verifyEmail', () => {
  it('devrait refuser un jeton de vérification inconnu', async () => {
    const { service } = makeService({ find: findChain([]) });
    await expect(service.verifyEmail('jeton')).rejects.toThrow(
      new BadRequestException(ErrorCodes.INVALID_VERIFICATION_TOKEN),
    );
  });

  it('devrait ignorer les comptes sans jeton de vérification', async () => {
    const { service } = makeService({
      find: findChain([{ _id: new Types.ObjectId(), emailVerificationToken: null }]),
    });
    await expect(service.verifyEmail('jeton')).rejects.toThrow(BadRequestException);
  });

  it('devrait marquer le courriel comme vérifié et purger le jeton', async () => {
    const userId = new Types.ObjectId();
    const findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    const { service } = makeService({
      find: findChain([{ _id: userId, emailVerificationToken: await bcrypt.hash('bon', 4) }]),
      findByIdAndUpdate,
    });

    await service.verifyEmail('bon');

    const [id, update] = findByIdAndUpdate.mock.calls[0];
    expect(id).toBe(userId);
    expect(update).toMatchObject({
      isEmailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiresAt: null,
    });
  });
});

describe('AuthService — resendVerification', () => {
  it('devrait rester silencieux si le compte est inconnu ou déjà vérifié', async () => {
    const findByIdAndUpdate = jest.fn();
    const { service, emailsService } = makeService({
      findOne: findOneChain(null),
      findByIdAndUpdate,
    });
    await expect(service.resendVerification('a@b.ca')).resolves.toBeUndefined();
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
    expect(emailsService.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('devrait régénérer un jeton hashé et l’envoyer', async () => {
    const findByIdAndUpdate = jest.fn().mockResolvedValue(null);
    const { service, emailsService } = makeService({
      findOne: findOneChain({ _id: new Types.ObjectId(), email: 'a@b.ca', fullName: 'A' }),
      findByIdAndUpdate,
    });

    await service.resendVerification('a@b.ca');

    const [, update] = findByIdAndUpdate.mock.calls[0];
    const sentToken = emailsService.sendEmailVerification.mock.calls[0][1].token as string;
    await expect(bcrypt.compare(sentToken, update.emailVerificationToken as string)).resolves.toBe(true);
    expect(update.emailVerificationExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('devrait absorber un échec d’envoi', async () => {
    const { service } = makeService(
      {
        findOne: findOneChain({ _id: new Types.ObjectId(), email: 'a@b.ca', fullName: 'A' }),
        findByIdAndUpdate: jest.fn().mockResolvedValue(null),
      },
      { sendEmailVerification: jest.fn().mockRejectedValue(new Error('SMTP down')) },
    );
    await expect(service.resendVerification('a@b.ca')).resolves.toBeUndefined();
  });
});
