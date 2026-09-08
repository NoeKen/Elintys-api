import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { NotificationsController } from '../src/modules/notifications/notifications.controller';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

describe('Notifications HTTP routing contract (e2e)', () => {
  let app: INestApplication;

  const notificationsService = {
    markAllRead: jest.fn().mockResolvedValue(undefined),
    markRead: jest.fn().mockResolvedValue(undefined),
    findByUser: jest.fn().mockResolvedValue([]),
    countUnread: jest.fn().mockResolvedValue({ count: 0 }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: notificationsService }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = {
        sub: '507f1f77bcf86cd799439011',
        email: 'qa@example.com',
        roles: ['organizer'],
      };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => jest.clearAllMocks());

  it('résout PATCH /notifications/read-all avant la route paramétrée :id/read', async () => {
    await request(app.getHttpServer()).patch('/notifications/read-all').expect(204);

    expect(notificationsService.markAllRead).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
    );
    expect(notificationsService.markRead).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejette une pagination invalide : page=%s', async (page) => {
    await request(app.getHttpServer())
      .get('/notifications/me')
      .query({ page })
      .expect(400);

    expect(notificationsService.findByUser).not.toHaveBeenCalled();
  });

  it.each(['yes', '1'])('rejette un filtre booléen ambigu : unreadOnly=%s', async (unreadOnly) => {
    await request(app.getHttpServer())
      .get('/notifications/me')
      .query({ unreadOnly })
      .expect(400);

    expect(notificationsService.findByUser).not.toHaveBeenCalled();
  });
});
