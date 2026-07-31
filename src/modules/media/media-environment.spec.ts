import { getMediaRootPrefix } from './media-environment';

describe('media environment', () => {
  it('construit le préfixe Cloudinary exact et sensible à la casse', () => {
    expect(getMediaRootPrefix('dev')).toBe('Elintys/dev');
    expect(getMediaRootPrefix('prod')).toBe('Elintys/prod');
  });

  it.each([undefined, '', 'staging', 'production'])(
    'refuse un environnement ambigu (%s)',
    (environment) => {
      expect(() => getMediaRootPrefix(environment as never)).toThrow(
        'MEDIA_ENVIRONMENT_INVALID',
      );
    },
  );
});
