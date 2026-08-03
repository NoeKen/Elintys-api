import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { EventMediaService } from './event-media.service';
import { Event } from './event.schema';
import { ImageFileValidationService } from '../media/image-file-validation.service';
import {
  MEDIA_STORAGE,
  MediaStorage,
} from '../media/media-storage.interface';
import type { MediaImage } from '../media/media-image.schema';
import { MediaCleanupService } from '../media/media-cleanup.service';
import { ConfigService } from '@nestjs/config';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

function chain<T>(value: T) {
  const result = {
    lean: jest.fn(),
    select: jest.fn(),
    then: (
      resolve?: (resolved: T) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject),
  };
  result.lean.mockReturnValue(result);
  result.select.mockReturnValue(result);
  return result;
}

describe('EventMediaService', () => {
  let service: EventMediaService;
  let eventModel: {
    findById: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let storage: jest.Mocked<MediaStorage>;
  let validator: {
    validateAndNormalize: jest.Mock;
  };
  const mediaCleanup = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const file = {
    buffer: Buffer.from('input'),
    size: 5,
    mimetype: 'image/jpeg',
  } as Express.Multer.File;
  const uploadedCover: MediaImage = {
    url: 'https://res.cloudinary.com/demo/image/upload/cover.jpg',
    publicId: `Elintys/dev/events/${eventId}/cover/new-cover`,
    width: 1920,
    height: 1080,
  };
  const existingCover: MediaImage = {
    url: 'https://res.cloudinary.com/demo/image/upload/old.jpg',
    publicId: `Elintys/dev/events/${eventId}/cover/old-cover`,
    width: 1920,
    height: 1080,
  };

  beforeEach(async () => {
    eventModel = {
      findById: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    storage = {
      uploadImage: jest.fn(),
      deleteImage: jest.fn(),
      getDeliveryUrl: jest.fn(),
    };
    validator = {
      validateAndNormalize: jest.fn().mockResolvedValue({
        buffer: Buffer.from('normalized'),
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
      }),
    };

    testingModule = await Test.createTestingModule({
      providers: [
        EventMediaService,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: MEDIA_STORAGE, useValue: storage },
        { provide: ImageFileValidationService, useValue: validator },
        { provide: MediaCleanupService, useValue: mediaCleanup },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('dev') },
        },
      ],
    }).compile();
    service = testingModule.get(EventMediaService);
  });

  afterEach(() => jest.clearAllMocks());

  function ownedEvent(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(eventId),
      organizer: new Types.ObjectId(organizerId),
      coverImage: null,
      gallery: [],
      ...overrides,
    };
  }

  it('téléverse puis persiste une couverture', async () => {
    eventModel.findById.mockReturnValue(chain(ownedEvent()));
    storage.uploadImage.mockResolvedValue(uploadedCover);
    eventModel.findOneAndUpdate.mockReturnValue(
      chain({ coverImage: uploadedCover, gallery: [] }),
    );

    const result = await service.uploadCover(eventId, organizerId, file);

    expect(storage.uploadImage).toHaveBeenCalledWith({
      buffer: Buffer.from('normalized'),
      publicId: expect.stringMatching(
        new RegExp(`^Elintys/dev/events/${eventId}/cover/`),
      ),
    });
    expect(result.coverImage).toEqual(uploadedCover);
  });

  it('isole les uploads de production sous Elintys/prod', async () => {
    const productionService = new EventMediaService(
      eventModel as never,
      storage,
      validator as never,
      mediaCleanup as never,
      { get: jest.fn().mockReturnValue('prod') } as unknown as ConfigService,
    );
    eventModel.findById.mockReturnValue(chain(ownedEvent()));
    storage.uploadImage.mockResolvedValue({
      ...uploadedCover,
      publicId: `Elintys/prod/events/${eventId}/cover/new-cover`,
    });
    eventModel.findOneAndUpdate.mockReturnValue(
      chain({
        coverImage: uploadedCover,
        gallery: [],
      }),
    );

    await productionService.uploadCover(eventId, organizerId, file);

    expect(storage.uploadImage).toHaveBeenCalledWith({
      buffer: Buffer.from('normalized'),
      publicId: expect.stringMatching(
        new RegExp(`^Elintys/prod/events/${eventId}/cover/`),
      ),
    });
  });

  it('supprime l’ancienne couverture seulement après la persistance', async () => {
    eventModel.findById.mockReturnValue(
      chain(ownedEvent({ coverImage: existingCover })),
    );
    storage.uploadImage.mockResolvedValue(uploadedCover);
    eventModel.findOneAndUpdate.mockReturnValue(
      chain({ coverImage: uploadedCover, gallery: [] }),
    );

    await service.uploadCover(eventId, organizerId, file);

    expect(storage.deleteImage).toHaveBeenCalledWith(existingCover.publicId);
    expect(
      eventModel.findOneAndUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.deleteImage.mock.invocationCallOrder[0]);
  });

  it('nettoie le nouvel actif si MongoDB échoue', async () => {
    eventModel.findById.mockReturnValue(chain(ownedEvent()));
    storage.uploadImage.mockResolvedValue(uploadedCover);
    eventModel.findOneAndUpdate.mockImplementation(() => {
      throw new Error('mongo unavailable');
    });

    await expect(
      service.uploadCover(eventId, organizerId, file),
    ).rejects.toThrow('mongo unavailable');
    expect(storage.deleteImage).toHaveBeenCalledWith(uploadedCover.publicId);
  });

  it('refuse un événement appartenant à un autre organisateur avant upload', async () => {
    eventModel.findById.mockReturnValue(
      chain(
        ownedEvent({
          organizer: new Types.ObjectId(),
        }),
      ),
    );

    await expect(
      service.uploadCover(eventId, organizerId, file),
    ).rejects.toThrow(ForbiddenException);
    expect(storage.uploadImage).not.toHaveBeenCalled();
  });

  it('refuse une galerie qui dépasserait dix images', async () => {
    eventModel.findById.mockReturnValue(
      chain(
        ownedEvent({
          gallery: Array.from({ length: 10 }, (_, index) => ({
            ...uploadedCover,
            publicId: `Elintys/dev/events/${eventId}/gallery/${index}`,
          })),
        }),
      ),
    );

    await expect(
      service.uploadGallery(eventId, organizerId, [file]),
    ).rejects.toThrow(BadRequestException);
    expect(storage.uploadImage).not.toHaveBeenCalled();
  });

  it('ajoute plusieurs images avec une limite MongoDB atomique', async () => {
    eventModel.findById.mockReturnValue(chain(ownedEvent()));
    const first = {
      ...uploadedCover,
      publicId: `Elintys/dev/events/${eventId}/gallery/first`,
    };
    const second = {
      ...uploadedCover,
      publicId: `Elintys/dev/events/${eventId}/gallery/second`,
    };
    storage.uploadImage
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    eventModel.findOneAndUpdate.mockReturnValue(
      chain({ coverImage: null, gallery: [first, second] }),
    );

    const result = await service.uploadGallery(
      eventId,
      organizerId,
      [file, file],
    );

    expect(result.gallery).toEqual([first, second]);
    expect(eventModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ $expr: expect.any(Object) }),
      { $push: { gallery: { $each: [first, second] } } },
      { new: true, runValidators: true },
    );
  });

  it('nettoie les uploads réussis lorsqu’un lot galerie échoue partiellement', async () => {
    eventModel.findById.mockReturnValue(chain(ownedEvent()));
    const galleryImage = {
      ...uploadedCover,
      publicId: `Elintys/dev/events/${eventId}/gallery/first`,
    };
    storage.uploadImage
      .mockResolvedValueOnce(galleryImage)
      .mockRejectedValueOnce(
        new ServiceUnavailableException('MEDIA_UPLOAD_FAILED'),
      );

    await expect(
      service.uploadGallery(eventId, organizerId, [file, file]),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(storage.deleteImage).toHaveBeenCalledWith(galleryImage.publicId);
    expect(eventModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rend la suppression galerie idempotente', async () => {
    eventModel.findById.mockReturnValue(chain(ownedEvent()));

    const result = await service.deleteGalleryImage(
      eventId,
      organizerId,
      `Elintys/dev/events/${eventId}/gallery/absent`,
    );

    expect(result.gallery).toEqual([]);
    expect(eventModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(storage.deleteImage).not.toHaveBeenCalled();
  });

  it('retire la référence MongoDB avant de supprimer l’actif distant', async () => {
    const image = {
      ...uploadedCover,
      publicId: `Elintys/dev/events/${eventId}/gallery/image`,
    };
    eventModel.findById.mockReturnValue(
      chain(ownedEvent({ gallery: [image] })),
    );
    eventModel.findOneAndUpdate.mockReturnValue(
      chain({ coverImage: null, gallery: [] }),
    );

    await service.deleteGalleryImage(eventId, organizerId, image.publicId);

    expect(
      eventModel.findOneAndUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.deleteImage.mock.invocationCallOrder[0]);
  });

  it('conserve le nouvel état si le nettoyage Cloudinary échoue après suppression', async () => {
    const image = {
      ...uploadedCover,
      publicId: `Elintys/dev/events/${eventId}/gallery/image`,
    };
    eventModel.findById.mockReturnValue(
      chain(ownedEvent({ gallery: [image] })),
    );
    eventModel.findOneAndUpdate.mockReturnValue(
      chain({ coverImage: null, gallery: [] }),
    );
    storage.deleteImage.mockRejectedValue(
      new ServiceUnavailableException('MEDIA_DELETE_FAILED'),
    );

    await expect(
      service.deleteGalleryImage(eventId, organizerId, image.publicId),
    ).resolves.toEqual({ coverImage: null, gallery: [] });
    expect(mediaCleanup.enqueue).toHaveBeenCalledWith(image.publicId);
  });
});
