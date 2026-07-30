import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  MEDIA_STORAGE,
  MediaStorage,
} from './media-storage.interface';
import {
  MediaCleanupTask,
  MediaCleanupTaskDocument,
} from './media-cleanup-task.schema';

const CLEANUP_INTERVAL_MS = 5 * 60_000;
const CLEANUP_BATCH_SIZE = 20;

@Injectable()
export class MediaCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanupService.name);
  private interval?: NodeJS.Timeout;
  private processing = false;

  constructor(
    @InjectModel(MediaCleanupTask.name)
    private readonly taskModel: Model<MediaCleanupTaskDocument>,
    @Inject(MEDIA_STORAGE)
    private readonly mediaStorage: MediaStorage,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.processDueTasks();
    }, CLEANUP_INTERVAL_MS);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async enqueue(publicId: string): Promise<void> {
    try {
      await this.taskModel.updateOne(
        { publicId },
        {
          $setOnInsert: {
            publicId,
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      this.logger.error(
        `Unable to persist deferred media cleanup task for ${publicId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async processDueTasks(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const tasks = await this.taskModel
        .find({ nextAttemptAt: { $lte: new Date() } })
        .sort({ nextAttemptAt: 1 })
        .limit(CLEANUP_BATCH_SIZE);

      for (const task of tasks) {
        try {
          await this.mediaStorage.deleteImage(task.publicId);
          await this.taskModel.deleteOne({ _id: task._id });
        } catch {
          const attempts = task.attempts + 1;
          const delayMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
          await this.taskModel.updateOne(
            { _id: task._id },
            {
              $set: {
                attempts,
                lastAttemptAt: new Date(),
                nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
              },
            },
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
