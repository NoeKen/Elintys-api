import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationType } from './notification.schema';

const makeChainable = (resolveWith: unknown) => ({
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(resolveWith),
});

const mockNotificationModel = {
  create: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
};

const mockUserId = new Types.ObjectId().toString();

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getModelToken(Notification.name),
          useValue: mockNotificationModel,
        },
      ],
    }).compile();
    service = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('devrait être défini', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('devrait créer une notification avec le bon type et userId', async () => {
      const mockNotif = {
        _id: new Types.ObjectId(),
        type: NotificationType.TICKET_SOLD,
        read: false,
        payload: { eventId: 'abc' },
      };
      mockNotificationModel.create.mockResolvedValueOnce(mockNotif);

      const result = await service.create(mockUserId, NotificationType.TICKET_SOLD, {
        eventId: 'abc',
      });

      expect(mockNotificationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.any(Types.ObjectId),
          type: NotificationType.TICKET_SOLD,
          payload: { eventId: 'abc' },
        }),
      );
      expect(result.read).toBe(false);
    });
  });

  describe('findByUser', () => {
    it("devrait retourner les notifications d'un utilisateur", async () => {
      const mockNotifs = [{ type: 'VENDOR_RESPONDED' }, { type: 'TICKET_SOLD' }];
      mockNotificationModel.find.mockReturnValue(makeChainable(mockNotifs));

      const result = await service.findByUser(mockUserId);
      expect(result).toHaveLength(2);
    });

    it('devrait filtrer uniquement les non-lues si unreadOnly est true', async () => {
      mockNotificationModel.find.mockReturnValue(makeChainable([]));

      await service.findByUser(mockUserId, { unreadOnly: true });

      expect(mockNotificationModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ read: false }),
      );
    });
  });

  describe('markRead', () => {
    it('devrait mettre à jour read à true pour une notification', async () => {
      mockNotificationModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValueOnce(null),
      });

      await service.markRead(new Types.ObjectId().toString(), mockUserId);

      expect(mockNotificationModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: expect.any(Types.ObjectId),
          userId: expect.any(Types.ObjectId),
        }),
        { read: true },
      );
    });
  });

  describe('markAllRead', () => {
    it('devrait marquer toutes les notifications non-lues comme lues', async () => {
      mockNotificationModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValueOnce({ modifiedCount: 3 }),
      });

      await service.markAllRead(mockUserId);

      expect(mockNotificationModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ read: false }),
        { read: true },
      );
    });
  });
});
