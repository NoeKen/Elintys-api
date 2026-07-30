import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryMediaStorageService } from './cloudinary-media-storage.service';

describe('CloudinaryMediaStorageService', () => {
  it('refuse explicitement les valeurs de configuration de démonstration', async () => {
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          'cloudinary.cloudName': 'Root',
          'cloudinary.apiKey': 'not-a-real-key',
          'cloudinary.apiSecret': 'not-a-real-secret',
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    const service = new CloudinaryMediaStorageService(config);

    await expect(
      service.uploadImage({
        buffer: Buffer.from('image'),
        publicId: 'elintys/events/event/cover/image',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
