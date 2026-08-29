import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CreateTicketOrderDto } from '../src/modules/tickets/orders/dto/create-ticket-order.dto';

/**
 * Contrat HTTP de création de commande payante.
 *
 * Vérifie la propriété de sécurité la plus importante de l'API Vague 5 :
 * AUCUN champ d'autorité ne peut être injecté par le client — ni `buyerId`,
 * ni `paid`, ni `paymentStatus`, ni `sold`, ni `reserved`. La pipeline de
 * validation les rejette avant même d'atteindre le service.
 */
@Controller('ticket-orders-contract')
class TicketOrdersContractController {
  @Post()
  create(@Body() dto: CreateTicketOrderDto) {
    return { accepted: true, lines: dto.lines.length, scenario: dto.paymentScenario ?? null };
  }
}

const TICKET_TYPE_ID = '664f1a2b3c4d5e6f7a8b9c0d';

describe('Ticket order HTTP contract (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TicketOrdersContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  it('devrait accepter une commande valide à une ligne', async () => {
    await request(app.getHttpServer())
      .post('/ticket-orders-contract')
      .send({ lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 2 }] })
      .expect(201, { accepted: true, lines: 1, scenario: null });
  });

  it('devrait accepter une commande multi-lignes', async () => {
    await request(app.getHttpServer())
      .post('/ticket-orders-contract')
      .send({
        lines: [
          { ticketTypeId: TICKET_TYPE_ID, quantity: 1 },
          { ticketTypeId: '664f1a2b3c4d5e6f7a8b9c0e', quantity: 3 },
        ],
      })
      .expect(201, { accepted: true, lines: 2, scenario: null });
  });

  it.each([
    ['buyerId', { buyerId: '664f1a2b3c4d5e6f7a8b9c0f' }],
    ['participantId', { participantId: '664f1a2b3c4d5e6f7a8b9c0f' }],
    ['paid', { paid: true }],
    ['paymentStatus', { paymentStatus: 'SUCCEEDED' }],
    ['sold', { sold: 0 }],
    ['reserved', { reserved: 0 }],
    ['totalAmount', { totalAmount: 1 }],
    ['status', { status: 'PAID' }],
  ])('devrait rejeter le champ d\'autorité client %s', async (_name, extra) => {
    await request(app.getHttpServer())
      .post('/ticket-orders-contract')
      .send({ lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 1 }], ...extra })
      .expect(400);
  });

  it.each([
    ['aucune ligne', { lines: [] }],
    ['trop de lignes', {
      lines: Array.from({ length: 6 }, () => ({ ticketTypeId: TICKET_TYPE_ID, quantity: 1 })),
    }],
    ['quantité nulle', { lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 0 }] }],
    ['quantité excessive', { lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 11 }] }],
    ['quantité fractionnaire', { lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 1.5 }] }],
    ['identifiant non ObjectId', { lines: [{ ticketTypeId: 'not-an-id', quantity: 1 }] }],
    ['champ inconnu dans une ligne', {
      lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 1, unitPrice: 1 }],
    }],
    ['lines absent', {}],
  ])('devrait rejeter la commande invalide : %s', async (_name, body) => {
    await request(app.getHttpServer()).post('/ticket-orders-contract').send(body).expect(400);
  });

  it('devrait accepter un scénario de simulation connu', async () => {
    await request(app.getHttpServer())
      .post('/ticket-orders-contract')
      .send({
        lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 1 }],
        paymentScenario: 'DELAYED_SUCCESS',
      })
      .expect(201, { accepted: true, lines: 1, scenario: 'DELAYED_SUCCESS' });
  });

  it('devrait rejeter un scénario de simulation inconnu', async () => {
    await request(app.getHttpServer())
      .post('/ticket-orders-contract')
      .send({
        lines: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 1 }],
        paymentScenario: 'MARK_AS_PAID',
      })
      .expect(400);
  });
});
