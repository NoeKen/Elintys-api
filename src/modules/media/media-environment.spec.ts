import { getMediaRootPrefix } from './media-environment';

describe('media environment', () => {
  it('construit le préfixe Cloudinary exact et sensible à la casse', () => {
    expect(getMediaRootPrefix('dev')).toBe('Elintys/dev');
    expect(getMediaRootPrefix('prod')).toBe('Elintys/prod');
    expect(getMediaRootPrefix('uat')).toBe('Elintys/uat');
    expect(getMediaRootPrefix('ci')).toBe('Elintys/ci');
  });

  it('devrait conserver le dossier historique dev pour un poste local', () => {
    expect(getMediaRootPrefix('local')).toBe('Elintys/dev');
  });

  it('devrait appliquer CLOUDINARY_FOLDER quand il est défini', () => {
    expect(getMediaRootPrefix('uat', 'uat')).toBe('Elintys/uat');
    expect(getMediaRootPrefix('local', 'local')).toBe('Elintys/local');
    expect(getMediaRootPrefix('dev', '  ')).toBe('Elintys/dev');
  });

  it.each(['../prod', 'UAT', 'a/b', '-x'])('refuse un dossier invalide (%s)', (folder) => {
    expect(() => getMediaRootPrefix('uat', folder)).toThrow('MEDIA_FOLDER_INVALID');
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
