import { assertDevelopmentSeedAllowed } from './seed-development';

describe('development seed guard', () => {
  const devUri =
    'mongodb+srv://user:password@example.mongodb.net/elintys-dev?retryWrites=true';

  it('autorise uniquement development avec la base elintys-dev', () => {
    expect(() =>
      assertDevelopmentSeedAllowed('dev', devUri),
    ).not.toThrow();
  });

  it('refuse ELINTYS_ENV=prod', () => {
    expect(() => assertDevelopmentSeedAllowed('prod', devUri)).toThrow(
      'SEED_REFUSED',
    );
  });

  it.each([
    'mongodb+srv://user:password@example.mongodb.net/elintys',
    'mongodb+srv://user:password@example.mongodb.net/elintys-prod',
    'mongodb://localhost:27017/elintys',
  ])('refuse la base non-dev %s', (uri) => {
    expect(() =>
      assertDevelopmentSeedAllowed('dev', uri),
    ).toThrow('database must be exactly "elintys-dev"');
  });
});
