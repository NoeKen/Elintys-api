import { Controller, Get, INestApplication, Query, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/filters/http-exception.filter';
import { escapeRegExp } from '../src/shared/utils/escape-regexp';
import {
  DISCOVERY_MAX_LIMIT,
  DISCOVERY_MAX_PAGE,
  DiscoveryEntityType,
  FeaturedDiscoveryDto,
  QueryDiscoveryEventsDto,
  QueryDiscoveryVenuesDto,
  QueryDiscoveryVendorsDto,
  SearchDiscoveryDto,
} from '../src/modules/discovery/dto/query-discovery.dto';

/**
 * Durcissement Discovery (B-02).
 *
 * Ces routes sont PUBLIQUES et anonymes : leur coût est entièrement supporté
 * par le serveur. Trois défauts y étaient exploitables sans compte —
 * pagination non bornée, regex utilisateur non échappée, absence de DTO donc
 * de liste blanche.
 */
@Controller('discovery-contract')
class DiscoveryContractController {
  @Get('search')
  search(@Query() query: SearchDiscoveryDto) {
    return query;
  }

  @Get('featured')
  featured(@Query() query: FeaturedDiscoveryDto) {
    return query;
  }

  @Get('vendors')
  vendors(@Query() query: QueryDiscoveryVendorsDto) {
    return query;
  }

  @Get('events')
  events(@Query() query: QueryDiscoveryEventsDto) {
    return query;
  }

  @Get('venues')
  venues(@Query() query: QueryDiscoveryVenuesDto) {
    return query;
  }
}

describe('Contrat Discovery (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DiscoveryContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  const get = (path: string) => request(app.getHttpServer()).get(path);

  describe('pagination bornée', () => {
    it('applique les valeurs par défaut', async () => {
      const response = await get('/discovery-contract/search?q=gala');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ page: 1, limit: 10 });
    });

    it.each([0, -1, -999])('refuse page=%p', async (page) => {
      // Un `skip` négatif faisait échouer Mongo : une valeur invalide
      // produisait une 500 au lieu d'un 400.
      const response = await get(`/discovery-contract/search?q=gala&page=${page}`);
      expect(response.status).toBe(400);
    });

    it.each([0, -5, DISCOVERY_MAX_LIMIT + 1, 100_000])('refuse limit=%p', async (limit) => {
      const response = await get(`/discovery-contract/search?q=gala&limit=${limit}`);
      expect(response.status).toBe(400);
    });

    it('accepte la limite maximale', async () => {
      const response = await get(`/discovery-contract/search?q=gala&limit=${DISCOVERY_MAX_LIMIT}`);
      expect(response.status).toBe(200);
    });

    it.each(['abc', '1.5', 'Infinity', 'NaN'])('refuse une page non entière %p', async (page) => {
      const response = await get(`/discovery-contract/search?q=gala&page=${page}`);
      expect(response.status).toBe(400);
    });

    it('refuse une page qui provoquerait un skip Mongo démesuré', async () => {
      expect((await get(`/discovery-contract/search?q=gala&page=${DISCOVERY_MAX_PAGE + 1}`)).status).toBe(400);
    });
  });

  describe('terme de recherche', () => {
    it('exige un terme sur /search', async () => {
      // Une recherche vide balayait tout le catalogue pour rien.
      const response = await get('/discovery-contract/search');
      expect(response.status).toBe(400);
    });

    it('refuse un terme trop court', async () => {
      expect((await get('/discovery-contract/search?q=a')).status).toBe(400);
    });

    it('applique la même longueur minimale aux filtres de catalogue', async () => {
      expect((await get('/discovery-contract/vendors?q=a')).status).toBe(400);
    });

    it('refuse un terme démesuré', async () => {
      const long = 'a'.repeat(500);
      expect((await get(`/discovery-contract/search?q=${long}`)).status).toBe(400);
    });

    it('accepte les accents et espaces', async () => {
      const response = await get('/discovery-contract/search?q=gala%20montr%C3%A9al');
      expect(response.status).toBe(200);
      expect(response.body.q).toBe('gala montréal');
    });
  });

  describe('injection d’opérateur Mongo', () => {
    it.each([
      'q[$ne]=1',
      'q[$regex]=.*',
      'limit[$gt]=1',
      'page[$ne]=1',
    ])('refuse %s', async (raw) => {
      // Express transforme `q[$ne]=1` en objet : sans DTO, cet objet
      // atteignait le filtre Mongo tel quel.
      const response = await get(`/discovery-contract/search?${raw}`);
      expect(response.status).toBe(400);
    });

    it('refuse un paramètre inattendu', async () => {
      const response = await get('/discovery-contract/search?q=gala&sort=%7B%22a%22%3A1%7D');
      expect(response.status).toBe(400);
    });
  });

  describe('énumérations', () => {
    it.each(Object.values(DiscoveryEntityType))('accepte le type de recherche %s', async (type) => {
      expect((await get(`/discovery-contract/search?q=gala&type=${type}`)).status).toBe(200);
    });

    it('refuse un type de recherche inventé', async () => {
      expect((await get('/discovery-contract/search?q=gala&type=admin')).status).toBe(400);
    });

    it('accepte une catégorie connue', async () => {
      expect((await get('/discovery-contract/vendors?category=photographe')).status).toBe(200);
    });

    it('refuse une catégorie inventée', async () => {
      expect((await get('/discovery-contract/vendors?category=hacker')).status).toBe(400);
    });
  });

  describe('filtres typés', () => {
    it('accepte une plage de dates calendrier valide', async () => {
      const response = await get('/discovery-contract/events?dateFrom=2027-05-01&dateTo=2027-05-31&type=gala');
      expect(response.status).toBe(200);
    });

    it.each(['2027-13-01', '01-05-2027', 'yesterday'])('refuse la date invalide %s', async (date) => {
      expect((await get(`/discovery-contract/events?dateFrom=${date}`)).status).toBe(400);
    });

    it('refuse une plage inversée', async () => {
      expect((await get('/discovery-contract/events?dateFrom=2027-06-01&dateTo=2027-05-01')).status).toBe(400);
    });

    it('accepte les filtres prestataire existants', async () => {
      expect((await get('/discovery-contract/vendors?city=Montr%C3%A9al&price=%24%24')).status).toBe(200);
    });

    it.each(['-1', '0', 'abc', '1.5', '1000001'])('refuse capacity=%s', async (capacity) => {
      expect((await get(`/discovery-contract/venues?capacity=${capacity}`)).status).toBe(400);
    });

    it('accepte type, ville et capacité pour un lieu', async () => {
      expect((await get('/discovery-contract/venues?type=reception&city=Montr%C3%A9al&capacity=200')).status).toBe(200);
    });
  });

  describe('échappement des expressions régulières', () => {
    it.each([
      ['(a+)+$', '\\(a\\+\\)\\+\\$'],
      ['.*', '\\.\\*'],
      ['^admin', '\\^admin'],
      ['a|b', 'a\\|b'],
      ['[a-z]{1,9}', '\\[a-z\\]\\{1,9\\}'],
    ])('neutralise %p', (raw, expected) => {
      // Un terme public non échappé permet le retour arrière catastrophique
      // (déni de service) et la réécriture du filtre.
      expect(escapeRegExp(raw)).toBe(expected);
    });

    it('un motif catastrophique devient littéral et ne backtrack plus', () => {
      const hostile = '(a+)+$';
      const subject = `${'a'.repeat(40)}b`;

      const started = Date.now();
      const matched = new RegExp(escapeRegExp(hostile), 'i').test(subject);

      expect(matched).toBe(false);
      // Le motif échappé cherche la chaîne littérale « (a+)+$ » : coût constant.
      expect(Date.now() - started).toBeLessThan(200);
    });
  });
});
