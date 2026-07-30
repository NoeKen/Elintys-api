import { BadRequestException, Injectable } from '@nestjs/common';
import sharp, { Sharp } from 'sharp';
import {
  ALLOWED_MEDIA_MIME_TYPES,
  AllowedMediaMimeType,
  MEDIA_MAX_FILE_SIZE,
  MEDIA_MAX_INPUT_PIXELS,
} from './media.constants';

export interface ValidatedImageFile {
  buffer: Buffer;
  mimeType: AllowedMediaMimeType;
  width: number;
  height: number;
}

export interface UploadedImageFile {
  buffer: Buffer;
  size: number;
  mimetype: string;
}

@Injectable()
export class ImageFileValidationService {
  async validateAndNormalize(
    file: UploadedImageFile | undefined,
  ): Promise<ValidatedImageFile> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('MEDIA_FILE_REQUIRED');
    }
    if (file.size > MEDIA_MAX_FILE_SIZE || file.buffer.length > MEDIA_MAX_FILE_SIZE) {
      throw new BadRequestException('MEDIA_FILE_TOO_LARGE');
    }
    if (
      !ALLOWED_MEDIA_MIME_TYPES.includes(
        file.mimetype as AllowedMediaMimeType,
      )
    ) {
      throw new BadRequestException('MEDIA_INVALID_TYPE');
    }

    const detectedType = this.detectMimeType(file.buffer);
    if (!detectedType || detectedType !== file.mimetype) {
      throw new BadRequestException('MEDIA_SIGNATURE_MISMATCH');
    }

    try {
      const input = sharp(file.buffer, {
        failOn: 'error',
        limitInputPixels: MEDIA_MAX_INPUT_PIXELS,
      });
      const metadata = await input.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        (metadata.pages ?? 1) > 1 ||
        this.formatToMimeType(metadata.format) !== detectedType
      ) {
        throw new Error('Unsupported or incomplete image metadata');
      }

      const pipeline = this.buildNormalizationPipeline(input, detectedType);
      const normalized = await pipeline.toBuffer({ resolveWithObject: true });
      if (
        !normalized.info.width ||
        !normalized.info.height ||
        normalized.data.length > MEDIA_MAX_FILE_SIZE
      ) {
        throw new Error('Normalized image exceeds accepted limits');
      }

      return {
        buffer: normalized.data,
        mimeType: detectedType,
        width: normalized.info.width,
        height: normalized.info.height,
      };
    } catch {
      throw new BadRequestException('MEDIA_CORRUPT_OR_UNSUPPORTED');
    }
  }

  private buildNormalizationPipeline(
    image: Sharp,
    mimeType: AllowedMediaMimeType,
  ): Sharp {
    const rotated = image.rotate();
    if (mimeType === 'image/jpeg') {
      return rotated.jpeg({ quality: 92, mozjpeg: true });
    }
    if (mimeType === 'image/png') {
      return rotated.png({ compressionLevel: 9 });
    }
    return rotated.webp({ quality: 92 });
  }

  private detectMimeType(buffer: Buffer): AllowedMediaMimeType | undefined {
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return 'image/jpeg';
    }
    if (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      return 'image/png';
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return undefined;
  }

  private formatToMimeType(format?: string): AllowedMediaMimeType | undefined {
    if (format === 'jpeg') return 'image/jpeg';
    if (format === 'png') return 'image/png';
    if (format === 'webp') return 'image/webp';
    return undefined;
  }
}
