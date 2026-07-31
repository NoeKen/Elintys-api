import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { MEDIA_MAX_GALLERY_IMAGES } from '../media/media.constants';
import {
  isManagedMediaImage,
  MediaImage,
} from '../media/media-image.schema';
import { ImageFileValidationService } from '../media/image-file-validation.service';
import { MediaCleanupService } from '../media/media-cleanup.service';
import {
  MEDIA_STORAGE,
  MediaStorage,
} from '../media/media-storage.interface';
import { Event, EventDocument } from './event.schema';
import { getMediaRootPrefix } from '../media/media-environment';

export interface EventMediaState {
  coverImage: MediaImage | string | null;
  gallery: MediaImage[];
}

type EventMediaSnapshot = Pick<Event, 'coverImage' | 'gallery' | 'organizer'> & {
  _id: Types.ObjectId;
};

@Injectable()
export class EventMediaService {
  private readonly logger = new Logger(EventMediaService.name);
  private readonly mediaRootPrefix: string;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
    @Inject(MEDIA_STORAGE)
    private readonly mediaStorage: MediaStorage,
    private readonly imageValidation: ImageFileValidationService,
    private readonly mediaCleanup: MediaCleanupService,
    configService: ConfigService,
  ) {
    this.mediaRootPrefix = getMediaRootPrefix(
      configService.get<'dev' | 'prod'>('elintysEnv'),
    );
  }

  async uploadCover(
    eventId: string,
    organizerId: string,
    file: Express.Multer.File | undefined,
  ): Promise<EventMediaState> {
    const event = await this.findOwnedMedia(eventId, organizerId);
    const validated = await this.imageValidation.validateAndNormalize(file);
    const publicId = this.createPublicId(eventId, 'cover');
    const uploaded = await this.mediaStorage.uploadImage({
      buffer: validated.buffer,
      publicId,
    });

    let updated: Event | null;
    try {
      updated = await this.eventModel
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(eventId),
            organizer: new Types.ObjectId(organizerId),
          },
          { $set: { coverImage: uploaded } },
          { new: true, runValidators: true },
        )
        .lean()
        .select('coverImage gallery');
    } catch (error) {
      await this.cleanupUploadedMedia([uploaded], 'cover DB rollback');
      throw error;
    }

    if (!updated) {
      await this.cleanupUploadedMedia([uploaded], 'cover ownership rollback');
      throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    }

    if (
      isManagedMediaImage(event.coverImage) &&
      event.coverImage.publicId !== uploaded.publicId &&
      this.isOwnedPublicId(eventId, event.coverImage.publicId, 'cover')
    ) {
      await this.deleteBestEffort(event.coverImage.publicId, 'replaced cover');
    }

    return this.toMediaState(updated);
  }

  async deleteCover(
    eventId: string,
    organizerId: string,
  ): Promise<EventMediaState> {
    const event = await this.findOwnedMedia(eventId, organizerId);
    if (!event.coverImage) return this.toMediaState(event);

    const updated = await this.eventModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(eventId),
          organizer: new Types.ObjectId(organizerId),
        },
        { $unset: { coverImage: 1 } },
        { new: true },
      )
      .lean()
      .select('coverImage gallery');
    if (!updated) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);

    if (
      isManagedMediaImage(event.coverImage) &&
      this.isOwnedPublicId(eventId, event.coverImage.publicId, 'cover')
    ) {
      await this.deleteBestEffort(event.coverImage.publicId, 'deleted cover');
    }
    return this.toMediaState(updated);
  }

  async uploadGallery(
    eventId: string,
    organizerId: string,
    files: Express.Multer.File[] | undefined,
  ): Promise<EventMediaState> {
    const event = await this.findOwnedMedia(eventId, organizerId);
    if (!files?.length) throw new BadRequestException('MEDIA_FILES_REQUIRED');

    const currentCount = event.gallery?.length ?? 0;
    if (currentCount + files.length > MEDIA_MAX_GALLERY_IMAGES) {
      throw new BadRequestException('EVENT_GALLERY_LIMIT_EXCEEDED');
    }

    const validatedFiles = [];
    for (const file of files) {
      validatedFiles.push(
        await this.imageValidation.validateAndNormalize(file),
      );
    }
    const uploadResults = await this.mapSettledWithConcurrency(
      validatedFiles,
      3,
      (validated) =>
        this.mediaStorage.uploadImage({
          buffer: validated.buffer,
          publicId: this.createPublicId(eventId, 'gallery'),
        }),
    );
    const uploaded = uploadResults
      .filter(
        (result): result is PromiseFulfilledResult<MediaImage> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value);
    const failed = uploadResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) {
      await this.cleanupUploadedMedia(uploaded, 'partial gallery upload rollback');
      throw failed.reason;
    }

    let updated: Event | null;
    try {
      updated = await this.eventModel
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(eventId),
            organizer: new Types.ObjectId(organizerId),
            $expr: {
              $lte: [
                {
                  $add: [
                    { $size: { $ifNull: ['$gallery', []] } },
                    uploaded.length,
                  ],
                },
                MEDIA_MAX_GALLERY_IMAGES,
              ],
            },
          },
          { $push: { gallery: { $each: uploaded } } },
          { new: true, runValidators: true },
        )
        .lean()
        .select('coverImage gallery');
    } catch (error) {
      await this.cleanupUploadedMedia(uploaded, 'gallery DB rollback');
      throw error;
    }

    if (!updated) {
      await this.cleanupUploadedMedia(uploaded, 'gallery capacity rollback');
      throw new BadRequestException('EVENT_GALLERY_LIMIT_EXCEEDED');
    }
    return this.toMediaState(updated);
  }

  async deleteGalleryImage(
    eventId: string,
    organizerId: string,
    publicId: string,
  ): Promise<EventMediaState> {
    const event = await this.findOwnedMedia(eventId, organizerId);
    const target = (event.gallery ?? []).find(
      (image) => image.publicId === publicId,
    );
    if (!target) return this.toMediaState(event);
    if (!this.isOwnedPublicId(eventId, publicId, 'gallery')) {
      throw new ForbiddenException(ErrorCodes.ACCESS_DENIED);
    }

    const updated = await this.eventModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(eventId),
          organizer: new Types.ObjectId(organizerId),
          'gallery.publicId': publicId,
        },
        { $pull: { gallery: { publicId } } },
        { new: true },
      )
      .lean()
      .select('coverImage gallery');
    if (!updated) return this.toMediaState(event);

    await this.deleteBestEffort(publicId, 'deleted gallery image');
    return this.toMediaState(updated);
  }

  async cleanupAfterEventDeletion(
    eventId: string,
    event: Pick<Event, 'coverImage' | 'gallery'>,
  ): Promise<void> {
    const media = [
      ...(isManagedMediaImage(event.coverImage) ? [event.coverImage] : []),
      ...(event.gallery ?? []),
    ].filter(
      (image) =>
        this.isOwnedPublicId(eventId, image.publicId, 'cover') ||
        this.isOwnedPublicId(eventId, image.publicId, 'gallery'),
    );
    await Promise.all(
      media.map((image) =>
        this.deleteBestEffort(image.publicId, 'event deletion cleanup'),
      ),
    );
  }

  private async findOwnedMedia(
    eventId: string,
    organizerId: string,
  ): Promise<EventMediaSnapshot> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    }
    const event = await this.eventModel
      .findById(eventId)
      .lean<EventMediaSnapshot>()
      .select('organizer coverImage gallery');
    if (!event) throw new NotFoundException(ErrorCodes.EVENT_NOT_FOUND);
    if (event.organizer.toString() !== organizerId) {
      throw new ForbiddenException(ErrorCodes.EVENT_NOT_OWNER);
    }
    return event;
  }

  private createPublicId(
    eventId: string,
    kind: 'cover' | 'gallery',
  ): string {
    return `${this.mediaRootPrefix}/events/${eventId}/${kind}/${randomUUID()}`;
  }

  private isOwnedPublicId(
    eventId: string,
    publicId: string,
    kind: 'cover' | 'gallery',
  ): boolean {
    return publicId.startsWith(
      `${this.mediaRootPrefix}/events/${eventId}/${kind}/`,
    );
  }

  private toMediaState(
    event: Pick<Event, 'coverImage' | 'gallery'>,
  ): EventMediaState {
    return {
      coverImage: event.coverImage ?? null,
      gallery: event.gallery ?? [],
    };
  }

  private async cleanupUploadedMedia(
    media: MediaImage[],
    context: string,
  ): Promise<void> {
    await Promise.all(
      media.map((image) => this.deleteBestEffort(image.publicId, context)),
    );
  }

  private async deleteBestEffort(
    publicId: string,
    context: string,
  ): Promise<void> {
    try {
      await this.mediaStorage.deleteImage(publicId);
    } catch {
      this.logger.warn(`Deferred media cleanup required (${context}): ${publicId}`);
      await this.mediaCleanup.enqueue(publicId);
    }
  }

  private async mapSettledWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<R>,
  ): Promise<Array<PromiseSettledResult<R>>> {
    const results: Array<PromiseSettledResult<R>> = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        try {
          results[currentIndex] = {
            status: 'fulfilled',
            value: await task(items[currentIndex]),
          };
        } catch (reason) {
          results[currentIndex] = { status: 'rejected', reason };
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker(),
      ),
    );
    return results;
  }
}
