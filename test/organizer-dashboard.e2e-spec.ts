import { Controller, Get, INestApplication, Query, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  OrganizerEventDate,
  OrganizerEventProgress,
  OrganizerEventSort,
  OrganizerEventView,
  QueryEventDto,
} from '../src/modules/events/dto/query-event.dto';

@Controller('organizer-events-contract')
class OrganizerEventsContractController {
  @Get()
  list(@Query() query: QueryEventDto) {
    return query;
  }
}

describe('Organizer dashboard HTTP query contract (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizerEventsContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
  });

  afterAll(async () => app.close());

  it('accepte les filtres, la recherche, le tri et la pagination bornée', async () => {
    await request(app.getHttpServer())
      .get('/organizer-events-contract')
      .query({
        page: 2,
        limit: 100,
        view: OrganizerEventView.READY,
        search: '  Gala Montréal  ',
        discoverability: 'public',
        eventType: 'gala',
        accessPolicy: 'manual_approval',
        progress: OrganizerEventProgress.INCOMPLETE,
        date: OrganizerEventDate.UPCOMING,
        sort: OrganizerEventSort.DATE_ASC,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(expect.objectContaining({
          page: 2,
          limit: 100,
          view: 'ready',
          search: 'Gala Montréal',
        }));
      });
  });

  it.each([
    [{ page: 0 }],
    [{ limit: 101 }],
    [{ view: 'invented' }],
    [{ sort: 'random' }],
    [{ organizerId: 'arbitrary-user' }],
    [{ search: 'x'.repeat(121) }],
  ])('rejette les paramètres invalides ou non autorisés : %p', async (query) => {
    await request(app.getHttpServer())
      .get('/organizer-events-contract')
      .query(query)
      .expect(400);
  });
});
