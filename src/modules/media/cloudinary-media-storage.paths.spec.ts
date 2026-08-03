import { ServiceUnavailableException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryMediaStorageService } from './cloudinary-media-storage.service';

/**
 * Couverture des chemins Cloudinary : configuration, upload, suppression,
 * URLs de livraison (finding F-013 — priorité « Cloudinary »).
 * Le SDK est mocké : aucun appel réseau n'est effectué.
 */

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    url: jest.fn().mockReturnValue('https://res.cloudinary.com/demo/image/upload/x.jpg'),
    uploader: {
      upload_stream: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

const mockedCloudinary = cloudinary as jest.Mocked<typeof cloudinary>;

function makeService(config: Record<string, string | undefined>): CloudinaryMediaStorageService {
  return new CloudinaryMediaStorageService({
    get: jest.fn((key: string) => config[key]),
  } as never);
}

const VALID_CONFIG = {
  'cloudinary.cloudName': 'elintys-dev',
  'cloudinary.apiKey': '123456789',
  'cloudinary.apiSecret': 'un-secret-valide',
};

/** Simule le stream d'upload : appelle le callback avec (error, response). */
function stubUploadStream(error: unknown, response: unknown): void {
  (mockedCloudinary.uploader.upload_stream as unknown as jest.Mock).mockImplementation(
    (_options: unknown, callback: (e: unknown, r: unknown) => void) => ({
      end: () => callback(error, response),
    }),
  );
}

describe('CloudinaryMediaStorageService — configuration', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['cloudName vide', { ...VALID_CONFIG, 'cloudinary.cloudName': '' }],
    ['apiKey absente', { ...VALID_CONFIG, 'cloudinary.apiKey': undefined }],
    ['secret placeholder', { ...VALID_CONFIG, 'cloudinary.apiSecret': 'change-me' }],
    ['valeur "example"', { ...VALID_CONFIG, 'cloudinary.cloudName': 'example' }],
    ['valeur "your-key"', { ...VALID_CONFIG, 'cloudinary.apiKey': 'your_key' }],
    ['valeur "..."', { ...VALID_CONFIG, 'cloudinary.apiSecret': '...' }],
    ['espaces seulement', { ...VALID_CONFIG, 'cloudinary.cloudName': '   ' }],
  ])('devrait refuser une configuration invalide — %s', async (_label, config) => {
    await expect(
      makeService(config as never).deleteImage('elintys/dev/x'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('devrait configurer le SDK une seule fois (mémorisation)', async () => {
    stubUploadStream(undefined, {
      secure_url: 'https://res.cloudinary.com/x.jpg',
      public_id: 'p',
      width: 10,
      height: 10,
    });
    const service = makeService(VALID_CONFIG);
    await service.uploadImage({ publicId: 'p', buffer: Buffer.from('a') } as never);
    await service.uploadImage({ publicId: 'p2', buffer: Buffer.from('b') } as never);
    expect(mockedCloudinary.config).toHaveBeenCalledTimes(1);
  });
});

describe('CloudinaryMediaStorageService — uploadImage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devrait retourner les métadonnées de l’image téléversée', async () => {
    stubUploadStream(undefined, {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/cover.jpg',
      public_id: 'elintys/dev/events/1/cover',
      width: 1920,
      height: 1080,
    });
    const result = await makeService(VALID_CONFIG).uploadImage({
      publicId: 'elintys/dev/events/1/cover',
      buffer: Buffer.from('image'),
    } as never);
    expect(result).toEqual({
      url: 'https://res.cloudinary.com/demo/image/upload/cover.jpg',
      publicId: 'elintys/dev/events/1/cover',
      width: 1920,
      height: 1080,
    });
  });

  it('devrait téléverser sans écraser un asset existant', async () => {
    stubUploadStream(undefined, {
      secure_url: 'u',
      public_id: 'p',
      width: 1,
      height: 1,
    });
    await makeService(VALID_CONFIG).uploadImage({
      publicId: 'p',
      buffer: Buffer.from('x'),
    } as never);
    const [options] = (mockedCloudinary.uploader.upload_stream as unknown as jest.Mock).mock.calls[0];
    expect(options).toMatchObject({ overwrite: false, resource_type: 'image', type: 'upload' });
  });

  it('devrait convertir une erreur Cloudinary en MEDIA_UPLOAD_FAILED', async () => {
    stubUploadStream({ message: 'quota dépassé' }, undefined);
    await expect(
      makeService(VALID_CONFIG).uploadImage({ publicId: 'p', buffer: Buffer.from('x') } as never),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('devrait échouer si Cloudinary ne renvoie aucune réponse', async () => {
    stubUploadStream(undefined, undefined);
    await expect(
      makeService(VALID_CONFIG).uploadImage({ publicId: 'p', buffer: Buffer.from('x') } as never),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it.each([
    ['secure_url manquante', { public_id: 'p', width: 1, height: 1 }],
    ['public_id manquant', { secure_url: 'u', width: 1, height: 1 }],
    ['dimensions manquantes', { secure_url: 'u', public_id: 'p' }],
  ])('devrait rejeter une réponse incomplète — %s', async (_label, response) => {
    stubUploadStream(undefined, response);
    await expect(
      makeService(VALID_CONFIG).uploadImage({ publicId: 'p', buffer: Buffer.from('x') } as never),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('CloudinaryMediaStorageService — deleteImage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devrait supprimer en invalidant le cache CDN', async () => {
    (mockedCloudinary.uploader.destroy as jest.Mock).mockResolvedValue({ result: 'ok' });
    await makeService(VALID_CONFIG).deleteImage('elintys/dev/events/1/cover');
    expect(mockedCloudinary.uploader.destroy).toHaveBeenCalledWith(
      'elintys/dev/events/1/cover',
      { resource_type: 'image', invalidate: true },
    );
  });

  it('devrait convertir un échec en MEDIA_DELETE_FAILED', async () => {
    (mockedCloudinary.uploader.destroy as jest.Mock).mockRejectedValue(new Error('réseau'));
    await expect(makeService(VALID_CONFIG).deleteImage('p')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('CloudinaryMediaStorageService — getDeliveryUrl', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['cover', 1920, 1080],
    ['card', 800, 520],
    ['thumbnail', 360, 240],
  ])('devrait appliquer la transformation %s', (preset, width, height) => {
    makeService(VALID_CONFIG).getDeliveryUrl('elintys/dev/x', preset as never);
    const [, options] = (mockedCloudinary.url as jest.Mock).mock.calls[0];
    expect(options.transformation[0]).toMatchObject({
      width,
      height,
      crop: 'fill',
      gravity: 'auto',
      quality: 'auto',
      fetch_format: 'auto',
    });
    expect(options.secure).toBe(true);
  });
});
