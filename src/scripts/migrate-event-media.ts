import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { CloudinaryMediaStorageService } from '../modules/media/cloudinary-media-storage.service';
import {
  ImageFileValidationService,
  UploadedImageFile,
} from '../modules/media/image-file-validation.service';
import { MEDIA_MAX_FILE_SIZE } from '../modules/media/media.constants';
import { resolveElintysEnvironment } from '../config/elintys-environment';
import { getMediaRootPrefix } from '../modules/media/media-environment';

const ALLOWED_LEGACY_HOSTS = new Set([
  'images.unsplash.com',
  'res.cloudinary.com',
]);

interface LegacyEvent {
  _id: mongoose.Types.ObjectId;
  coverImage: string;
}

async function downloadLegacyImage(urlValue: string): Promise<UploadedImageFile> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || !ALLOWED_LEGACY_HOSTS.has(url.hostname)) {
    throw new Error(`Legacy media host is not allowed: ${url.hostname}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Legacy media download failed with HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MEDIA_MAX_FILE_SIZE) {
      throw new Error('Legacy media exceeds the 10 MB limit');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MEDIA_MAX_FILE_SIZE) {
        await reader.cancel();
        throw new Error('Legacy media exceeds the 10 MB limit');
      }
      chunks.push(value);
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? '';
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return {
      mimetype: mimeType,
      size: buffer.length,
      buffer,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const mediaRootPrefix = getMediaRootPrefix(
    resolveElintysEnvironment(
      process.env.ELINTYS_ENV,
      process.env.NODE_ENV ?? 'development',
    ),
  );
  await mongoose.connect(uri);

  const collection = mongoose.connection.db?.collection<LegacyEvent>('events');
  if (!collection) throw new Error('MongoDB connection is unavailable');
  const legacyEvents = await collection
    .find({ coverImage: { $type: 'string' } } as never)
    .toArray();
  const execute = process.argv.includes('--execute');

  if (!execute) {
    console.log(
      JSON.stringify({
        mode: 'dry-run',
        legacyCoverCount: legacyEvents.length,
        allowedHosts: [...ALLOWED_LEGACY_HOSTS],
        nextStep: 'Run npm run media:migrate -- --execute after configuring Cloudinary.',
      }),
    );
    return;
  }

  const config = new ConfigService({
    cloudinary: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      apiSecret: process.env.CLOUDINARY_API_SECRET,
    },
  });
  const storage = new CloudinaryMediaStorageService(config);
  const validator = new ImageFileValidationService();
  let migrated = 0;

  for (const event of legacyEvents) {
    const file = await downloadLegacyImage(event.coverImage);
    const normalized = await validator.validateAndNormalize(file);
    const uploaded = await storage.uploadImage({
      buffer: normalized.buffer,
      publicId: `${mediaRootPrefix}/events/${event._id.toString()}/cover/${randomUUID()}`,
    });
    const result = await collection.updateOne(
      { _id: event._id, coverImage: event.coverImage } as never,
      { $set: { coverImage: uploaded } } as never,
    );
    if (result.modifiedCount !== 1) {
      await storage.deleteImage(uploaded.publicId);
      throw new Error(`Concurrent update detected for event ${event._id.toString()}`);
    }
    migrated += 1;
  }

  console.log(JSON.stringify({ mode: 'execute', migrated }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unknown migration error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
