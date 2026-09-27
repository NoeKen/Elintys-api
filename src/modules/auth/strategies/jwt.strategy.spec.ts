import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy.validate', () => {
  const makeStrategy = (user: unknown) => {
    const select = jest.fn().mockResolvedValue(user);
    const lean = jest.fn().mockReturnValue({ select });
    const findById = jest.fn().mockReturnValue({ lean });
    const configService = { getOrThrow: jest.fn().mockReturnValue('x'.repeat(32)) };
    const strategy = new JwtStrategy(configService as never, { findById } as never);
    return { strategy, findById, select };
  };

  afterEach(() => jest.clearAllMocks());

  it('devrait relire isEmailVerified en base dans la même requête que l’existence du compte', async () => {
    const { strategy, findById, select } = makeStrategy({ _id: 'u1', isEmailVerified: true });
    const result = await strategy.validate({ sub: 'u1', email: 'a@b.ca', roles: ['participant'] });
    expect(findById).toHaveBeenCalledWith('u1');
    expect(select).toHaveBeenCalledWith('_id isEmailVerified');
    expect(result).toEqual({ sub: 'u1', email: 'a@b.ca', roles: ['participant'], isEmailVerified: true });
  });

  it('devrait écraser une valeur isEmailVerified forgée dans le payload', async () => {
    const { strategy } = makeStrategy({ _id: 'u1', isEmailVerified: false });
    const result = await strategy.validate({
      sub: 'u1', email: 'a@b.ca', roles: [], isEmailVerified: true,
    });
    expect(result.isEmailVerified).toBe(false);
  });

  it('devrait considérer un statut absent comme non vérifié', async () => {
    const { strategy } = makeStrategy({ _id: 'u1' });
    const result = await strategy.validate({ sub: 'u1', email: 'a@b.ca', roles: [] });
    expect(result.isEmailVerified).toBe(false);
  });

  it('devrait refuser un compte supprimé', async () => {
    const { strategy } = makeStrategy(null);
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.ca', roles: [] })).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
