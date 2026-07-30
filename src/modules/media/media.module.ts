import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CloudinaryMediaStorageService } from './cloudinary-media-storage.service';
import { ImageFileValidationService } from './image-file-validation.service';
import { MEDIA_STORAGE } from './media-storage.interface';
import {
  MediaCleanupTask,
  MediaCleanupTaskSchema,
} from './media-cleanup-task.schema';
import { MediaCleanupService } from './media-cleanup.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MediaCleanupTask.name, schema: MediaCleanupTaskSchema },
    ]),
  ],
  providers: [
    CloudinaryMediaStorageService,
    ImageFileValidationService,
    {
      provide: MEDIA_STORAGE,
      useExisting: CloudinaryMediaStorageService,
    },
    MediaCleanupService,
  ],
  exports: [MEDIA_STORAGE, ImageFileValidationService, MediaCleanupService],
})
export class MediaModule {}
