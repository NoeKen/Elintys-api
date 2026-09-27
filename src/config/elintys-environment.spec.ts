import {
  isStrictElintysEnvironment,
  resolveElintysEnvironment,
} from './elintys-environment';

describe('resolveElintysEnvironment', () => {
  it.each(['local', 'ci', 'dev', 'uat', 'prod'] as const)(
    'accepte la valeur explicite %s',
    (environment) => {
      expect(resolveElintysEnvironment(environment, 'production')).toBe(environment);
    },
  );

  it('ignore les espaces autour de la valeur', () => {
    expect(resolveElintysEnvironment(' uat ', 'production')).toBe('uat');
  });

  it.each(['development', 'test'])(
    'utilise local par défaut uniquement pour NODE_ENV=%s',
    (nodeEnv) => {
      expect(resolveElintysEnvironment(undefined, nodeEnv)).toBe('local');
      expect(resolveElintysEnvironment('', nodeEnv)).toBe('local');
    },
  );

  it('exige une valeur explicite avec NODE_ENV=production', () => {
    expect(() => resolveElintysEnvironment(undefined, 'production')).toThrow(
      'ELINTYS_ENV is required when NODE_ENV=production',
    );
  });

  it('exige une valeur explicite pour un NODE_ENV inconnu', () => {
    expect(() => resolveElintysEnvironment(undefined, 'staging')).toThrow('ELINTYS_ENV');
  });

  it.each(['staging', 'production', 'PROD', 'test'])('rejette la valeur %s', (value) => {
    expect(() => resolveElintysEnvironment(value, 'production')).toThrow(
      'ELINTYS_ENV must be one of: local, ci, dev, uat, prod.',
    );
  });

  it('classe uniquement uat et prod comme stricts', () => {
    expect(isStrictElintysEnvironment('uat')).toBe(true);
    expect(isStrictElintysEnvironment('prod')).toBe(true);
    expect(isStrictElintysEnvironment('dev')).toBe(false);
    expect(isStrictElintysEnvironment('local')).toBe(false);
    expect(isStrictElintysEnvironment('ci')).toBe(false);
  });
});
