import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { ImageFileValidationService } from './image-file-validation.service';
import { MEDIA_MAX_FILE_SIZE } from './media.constants';

describe('ImageFileValidationService', () => {
  const service = new ImageFileValidationService();

  async function createImage(
    format: 'jpeg' | 'png' | 'webp',
  ): Promise<Express.Multer.File> {
    const buffer = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: '#1a4550',
      },
    })
      .toFormat(format)
      .toBuffer();
    return {
      buffer,
      size: buffer.length,
      mimetype: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
    } as Express.Multer.File;
  }

  it.each(['jpeg', 'png', 'webp'] as const)(
    'accepte et redécode une image %s valide',
    async (format) => {
      const result = await service.validateAndNormalize(
        await createImage(format),
      );

      expect(result.width).toBe(32);
      expect(result.height).toBe(24);
      expect(result.buffer.length).toBeGreaterThan(0);
    },
  );

  it('rejette une signature différente du MIME annoncé', async () => {
    const file = await createImage('png');
    file.mimetype = 'image/jpeg';

    await expect(service.validateAndNormalize(file)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejette un contenu corrompu', async () => {
    await expect(
      service.validateAndNormalize({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]),
        size: 5,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejette les SVG et GIF', async () => {
    for (const mimetype of ['image/svg+xml', 'image/gif']) {
      await expect(
        service.validateAndNormalize({
          buffer: Buffer.from('<svg></svg>'),
          size: 11,
          mimetype,
        }),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('rejette un fichier supérieur à 10 Mo', async () => {
    await expect(
      service.validateAndNormalize({
        buffer: Buffer.alloc(MEDIA_MAX_FILE_SIZE + 1),
        size: MEDIA_MAX_FILE_SIZE + 1,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
