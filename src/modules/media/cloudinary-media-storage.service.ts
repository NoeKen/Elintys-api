import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UploadApiErrorResponse,
  UploadApiResponse,
  v2 as cloudinary,
} from 'cloudinary';
import { MediaImage } from './media-image.schema';
import {
  MediaDeliveryPreset,
  MediaStorage,
  UploadMediaImageInput,
} from './media-storage.interface';

const DELIVERY_TRANSFORMATIONS: Record<
  MediaDeliveryPreset,
  { width: number; height: number }
> = {
  cover: { width: 1920, height: 1080 },
  card: { width: 800, height: 520 },
  thumbnail: { width: 360, height: 240 },
};

@Injectable()
export class CloudinaryMediaStorageService implements MediaStorage {
  private readonly logger = new Logger(CloudinaryMediaStorageService.name);
  private configured = false;

  constructor(private readonly configService: ConfigService) {}

  async uploadImage(input: UploadMediaImageInput): Promise<MediaImage> {
    this.ensureConfigured();

    try {
      const result = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            public_id: input.publicId,
            resource_type: 'image',
            type: 'upload',
            overwrite: false,
            unique_filename: false,
            use_filename: false,
          },
          (
            error: UploadApiErrorResponse | undefined,
            response: UploadApiResponse | undefined,
          ) => {
            if (error || !response) {
              reject(error ?? new Error('Cloudinary returned no upload response'));
              return;
            }
            resolve(response);
          },
        );
        stream.end(input.buffer);
      });

      if (!result.secure_url || !result.public_id || !result.width || !result.height) {
        throw new Error('Cloudinary response is missing required image metadata');
      }

      return {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
      };
    } catch (error) {
      this.logger.error(
        `Cloudinary upload failed for media path ${input.publicId}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException('MEDIA_UPLOAD_FAILED');
    }
  }

  async deleteImage(publicId: string): Promise<void> {
    this.ensureConfigured();
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
        invalidate: true,
      });
    } catch (error) {
      this.logger.error(
        `Cloudinary deletion failed for media path ${publicId}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException('MEDIA_DELETE_FAILED');
    }
  }

  getDeliveryUrl(
    publicId: string,
    preset: MediaDeliveryPreset,
  ): string {
    this.ensureConfigured();
    const { width, height } = DELIVERY_TRANSFORMATIONS[preset];
    return cloudinary.url(publicId, {
      secure: true,
      resource_type: 'image',
      type: 'upload',
      transformation: [
        {
          width,
          height,
          crop: 'fill',
          gravity: 'auto',
          quality: 'auto',
          fetch_format: 'auto',
        },
      ],
    });
  }

  private ensureConfigured(): void {
    if (this.configured) return;

    const cloudName = this.configService.get<string>('cloudinary.cloudName');
    const apiKey = this.configService.get<string>('cloudinary.apiKey');
    const apiSecret = this.configService.get<string>('cloudinary.apiSecret');
    const missing = [cloudName, apiKey, apiSecret].some((value) => {
      const normalized = value?.trim() ?? '';
      return (
        !normalized ||
        /^(empty|root|your[_ -]|change[_ -]?me|example|placeholder|\.\.\.)/i.test(
          normalized,
        )
      );
    });
    if (missing) {
      throw new ServiceUnavailableException('MEDIA_STORAGE_NOT_CONFIGURED');
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
    this.configured = true;
  }
}
