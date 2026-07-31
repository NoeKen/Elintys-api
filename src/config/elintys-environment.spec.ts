import { resolveElintysEnvironment } from './elintys-environment';

describe('resolveElintysEnvironment', () => {
  it.each(['dev', 'prod'] as const)(
    'accepte la valeur explicite %s',
    (environment) => {
      expect(resolveElintysEnvironment(environment, 'production')).toBe(
        environment,
      );
    },
  );

  it.each(['development', 'test'])(
    'utilise dev par défaut uniquement pour NODE_ENV=%s',
    (nodeEnv) => {
      expect(resolveElintysEnvironment(undefined, nodeEnv)).toBe('dev');
    },
  );

  it('exige une valeur explicite avec NODE_ENV=production', () => {
    expect(() =>
      resolveElintysEnvironment(undefined, 'production'),
    ).toThrow('ELINTYS_ENV');
  });

  it('rejette toute autre valeur', () => {
    expect(() =>
      resolveElintysEnvironment('staging', 'production'),
    ).toThrow('ELINTYS_ENV');
  });
});
