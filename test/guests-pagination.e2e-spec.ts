import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GuestsController } from '../src/modules/guests/guests.controller';
import { GuestsService } from '../src/modules/guests/guests.service';

describe('Guests HTTP pagination contract (e2e)', () => {
  let app: INestApplication;

  const guestsService = {
    findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GuestsController],
      providers: [{ provide: GuestsService, useValue: guestsService }],
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

  it.each([
    { page: '0' },
    { page: 'abc' },
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
  ])('rejette la pagination invalide : %p', async (query) => {
    await request(app.getHttpServer())
      .get('/events/507f1f77bcf86cd799439012/guests')
      .query(query)
      .expect(400);

    expect(guestsService.findAll).not.toHaveBeenCalled();
  });
});
