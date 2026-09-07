import {
  Controller,
  Delete,
  Get,
  INestApplication,
  Param,
  Patch,
  Post,
  Body,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ParseObjectIdPipe } from '../src/shared/pipes/parse-object-id.pipe';
import { CreateReviewDto } from '../src/modules/reviews/dto/create-review.dto';
import { AllExceptionsFilter } from '../src/shared/filters/http-exception.filter';

/**
 * Contrat HTTP des identifiants MongoDB.
 *
 * Un ObjectId syntaxiquement invalide doit produire un 400 stable, jamais une
 * 500 Mongoose. L'audit avait relevé six routes — dont trois PUBLIQUES — où un
 * `CastError` remontait tel quel : bruit d'alerting, et fuite du type d'erreur
 * interne.
 *
 * Ce spec vérifie les DEUX mécanismes utilisés dans le dépôt : le pipe sur les
 * paramètres de route, et `@IsMongoId()` sur les corps de requête.
 */
@Controller('object-id-contract')
class ObjectIdContractController {
  @Get('param/:id')
  byParam(@Param('id', ParseObjectIdPipe) id: string) {
    return { id };
  }

  @Patch('param/:id/read')
  patchByParam(@Param('id', ParseObjectIdPipe) id: string) {
    return { id };
  }

  @Delete('param/:id')
  deleteByParam(@Param('id', ParseObjectIdPipe) id: string) {
    return { id };
  }

  @Get('target/:targetType/:targetId')
  byTarget(
    @Param('targetType') targetType: string,
    @Param('targetId', ParseObjectIdPipe) targetId: string,
  ) {
    return { targetType, targetId };
  }

  @Post('body')
  byBody(@Body() dto: CreateReviewDto) {
    return { targetId: dto.targetId };
  }
}

const VALID = '664f1a2b3c4d5e6f7a8b9c0d';

describe('Contrat HTTP des ObjectId (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ObjectIdContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // Le même filtre qu'en production : c'est lui qui transformait un
    // CastError non intercepté en 500.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  const INVALID_IDS = [
    'pas-un-id',
    '123',
    '',
    'null',
    'undefined',
    '664f1a2b3c4d5e6f7a8b9c0', // 23 caractères
    '664f1a2b3c4d5e6f7a8b9c0dd', // 25 caractères
    'zzzz1a2b3c4d5e6f7a8b9c0d', // hors hexadécimal
  ];

  describe('paramètres de route', () => {
    it.each(INVALID_IDS.filter(Boolean))('devrait refuser %p avec un 400', async (id) => {
      const response = await request(app.getHttpServer()).get(`/object-id-contract/param/${id}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('INVALID_OBJECT_ID');
    });

    it('devrait accepter un ObjectId valide', async () => {
      const response = await request(app.getHttpServer()).get(`/object-id-contract/param/${VALID}`);
      expect(response.status).toBe(200);
    });

    it.each(['patch', 'delete'] as const)(
      'devrait appliquer la même règle en %s',
      async (method) => {
        const path =
          method === 'patch'
            ? '/object-id-contract/param/pas-un-id/read'
            : '/object-id-contract/param/pas-un-id';
        const response = await request(app.getHttpServer())[method](path);

        expect(response.status).toBe(400);
      },
    );

    it('devrait valider la cible polymorphe des avis', async () => {
      const refused = await request(app.getHttpServer()).get(
        '/object-id-contract/target/event/pas-un-id',
      );
      const accepted = await request(app.getHttpServer()).get(
        `/object-id-contract/target/event/${VALID}`,
      );

      expect(refused.status).toBe(400);
      expect(accepted.status).toBe(200);
    });
  });

  describe('corps de requête', () => {
    const body = { targetType: 'event', rating: 5, comment: 'Excellent' };

    it.each(INVALID_IDS)('devrait refuser targetId %p avec un 400', async (targetId) => {
      const response = await request(app.getHttpServer())
        .post('/object-id-contract/body')
        .send({ ...body, targetId });

      expect(response.status).toBe(400);
    });

    it('devrait accepter un targetId valide', async () => {
      const response = await request(app.getHttpServer())
        .post('/object-id-contract/body')
        .send({ ...body, targetId: VALID });

      expect(response.status).toBe(201);
    });

    it('ne devrait jamais retourner une erreur interne', async () => {
      const response = await request(app.getHttpServer())
        .post('/object-id-contract/body')
        .send({ ...body, targetId: 'pas-un-id' });

      // Le point du finding : l'utilisateur recevait « Une erreur interne est
      // survenue » pour une simple faute de frappe dans une URL.
      expect(response.status).not.toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('erreur interne');
    });
  });
});
