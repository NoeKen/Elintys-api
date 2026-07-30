import { MediaImage } from './media-image.schema';

export type MediaDeliveryPreset = 'cover' | 'card' | 'thumbnail';

export interface UploadMediaImageInput {
  buffer: Buffer;
  publicId: string;
}

export interface MediaStorage {
  uploadImage(input: UploadMediaImageInput): Promise<MediaImage>;
  deleteImage(publicId: string): Promise<void>;
  getDeliveryUrl(publicId: string, preset: MediaDeliveryPreset): string;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
