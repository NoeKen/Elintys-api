export const MEDIA_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MEDIA_MAX_GALLERY_IMAGES = 10;
export const MEDIA_MAX_INPUT_PIXELS = 25_000_000;

export const ALLOWED_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedMediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number];
