import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, Throttle } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { ElintysThrottlerGuard } from '../src/shared/guards/elintys-throttler.guard';
import { THROTTLE_TIERS } from '../src/config/throttle.config';
import type { JwtPayload } from '../src/shared/decorators/current-user.decorator';

/**
 * Rate-limiting public — comportement derrière proxy (F-019).
 *
 * Le défaut d'origine : sans `trust proxy`, `req.ip` vaut l'adresse du proxy
 * de la plateforme et **tous** les visiteurs partagent un unique compteur. La
 * zone publique se rendait indisponible sous une charge que quelques dizaines
 * de visiteurs suffisent à produire.
 */

/** Tier volontairement bas : rend les seuils observables sans charge réelle. */
const TIER_TEST = { ttl: 60_000, limit: 5 };

@Controller('essai')
class EssaiController {
  @Get('public')
  @Throttle({ default: TIER_TEST })
  lecturePublique() {
    return { ok: true };
  }

  @Get('autre-public')
  @Throttle({ default: TIER_TEST })
  autreLecturePublique() {
    return { ok: true };
  }

  @Post('sensible')
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  routeSensible() {
    return { ok: true };
  }
}

/** Injecte une identité authentifiée, comme le ferait `JwtAuthGuard`. */
function identiteDepuisEnTete(request: Request, _: Response, next: NextFunction): void {
  const userId = request.headers['x-essai-user'];
  if (typeof userId === 'string') {
    (request as Request & { user?: JwtPayload }).user = { sub: userId } as JwtPayload;
  }
  next();
}

async function creerApp(trustedProxyHops: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ name: 'default', ...THROTTLE_TIERS.PUBLIC_READ }])],
    controllers: [EssaiController],
    providers: [{ provide: APP_GUARD, useClass: ElintysThrottlerGuard }],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', trustedProxyHops);
  app.use(identiteDepuisEnTete);
  await app.init();
  return app;
}

/** Enchaîne `n` requêtes et retourne le décompte des statuts. */
async function rafale(
  app: INestApplication,
  chemin: string,
  n: number,
  entetes: Record<string, string> = {},
): Promise<Record<number, number>> {
  const statuts: Record<number, number> = {};
  for (let i = 0; i < n; i += 1) {
    const reponse = await request(app.getHttpServer()).get(chemin).set(entetes);
    statuts[reponse.status] = (statuts[reponse.status] ?? 0) + 1;
  }
  return statuts;
}

describe('Throttling public derrière proxy (e2e)', () => {
  describe('sans proxy de confiance', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await creerApp(0);
    });
    afterAll(async () => {
      await app.close();
    });

    it('ne devrait jamais retenir un X-Forwarded-For fourni par le client', async () => {
      // Chaque requête annonce une IP différente. Aucune ne doit être crue :
      // le compteur reste celui de la socket, et le seuil est atteint.
      const statuts = await rafale(app, '/essai/public', 8, {});
      expect(statuts[200]).toBe(TIER_TEST.limit);
      expect(statuts[429]).toBe(3);
    });
  });

  describe('avec un proxy de confiance', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await creerApp(1);
    });
    afterAll(async () => {
      await app.close();
    });

    it('devrait compter chaque visiteur anonyme séparément', async () => {
      // Le cœur de F-019 : dix visiteurs derrière le même proxy ne doivent pas
      // se bloquer mutuellement.
      for (let visiteur = 0; visiteur < 10; visiteur += 1) {
        const statuts = await rafale(app, '/essai/public', TIER_TEST.limit, {
          'X-Forwarded-For': `203.0.113.${visiteur}`,
        });
        expect(statuts[429] ?? 0).toBe(0);
        expect(statuts[200]).toBe(TIER_TEST.limit);
      }
    });

    it('devrait tout de même limiter un même visiteur au-delà du seuil', async () => {
      const statuts = await rafale(app, '/essai/public', TIER_TEST.limit + 3, {
        'X-Forwarded-For': '198.51.100.1',
      });
      expect(statuts[200]).toBe(TIER_TEST.limit);
      expect(statuts[429]).toBe(3);
    });

    it('devrait ignorer une chaîne X-Forwarded-For forgée par le client', async () => {
      // Le client prétend venir d'ailleurs à chaque requête ; le proxy de
      // confiance ajoute sa véritable adresse en fin de chaîne. C'est celle-ci
      // qui doit être retenue, sinon le rate-limiting serait contournable en
      // faisant tourner un en-tête.
      const statuts: Record<number, number> = {};
      for (let i = 0; i < TIER_TEST.limit + 3; i += 1) {
        const reponse = await request(app.getHttpServer())
          .get('/essai/public')
          .set('X-Forwarded-For', `10.0.0.${i}, 192.0.2.50`);
        statuts[reponse.status] = (statuts[reponse.status] ?? 0) + 1;
      }
      expect(statuts[429]).toBe(3);
    });

    it('devrait compter les utilisateurs authentifiés séparément malgré une IP partagée', async () => {
      // Cas d'une entreprise, d'une université ou d'un Wi-Fi public : une seule
      // IP sortante, plusieurs personnes.
      for (const utilisateur of ['user-a', 'user-b', 'user-c']) {
        const statuts = await rafale(app, '/essai/public', TIER_TEST.limit, {
          'X-Forwarded-For': '192.0.2.200',
          'X-Essai-User': utilisateur,
        });
        expect(statuts[429] ?? 0).toBe(0);
      }
    });

    it('devrait cloisonner les compteurs par route', async () => {
      // Saturer une route publique ne doit pas fermer les autres.
      const entetes = { 'X-Forwarded-For': '198.51.100.77' };
      const saturee = await rafale(app, '/essai/public', TIER_TEST.limit + 2, entetes);
      expect(saturee[429]).toBe(2);

      const voisine = await rafale(app, '/essai/autre-public', TIER_TEST.limit, entetes);
      expect(voisine[429] ?? 0).toBe(0);
    });

    it('devrait conserver une limite stricte sur les routes sensibles', async () => {
      // Le desserrement public ne doit rien concéder aux routes protégées.
      const statuts: Record<number, number> = {};
      for (let i = 0; i < 5; i += 1) {
        const reponse = await request(app.getHttpServer())
          .post('/essai/sensible')
          .set('X-Forwarded-For', '203.0.113.250');
        statuts[reponse.status] = (statuts[reponse.status] ?? 0) + 1;
      }
      expect(statuts[201]).toBe(2);
      expect(statuts[429]).toBe(3);
    });

    it('devrait renvoyer un 429 structuré et exploitable', async () => {
      const entetes = { 'X-Forwarded-For': '198.51.100.99' };
      await rafale(app, '/essai/public', TIER_TEST.limit, entetes);
      const refus = await request(app.getHttpServer()).get('/essai/public').set(entetes);

      expect(refus.status).toBe(429);
      expect(refus.body).toMatchObject({ statusCode: 429 });
      expect(typeof refus.body.message).toBe('string');
    });
  });

  describe('récupération après la fenêtre', () => {
    let app: INestApplication;

    beforeAll(async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      app = await creerApp(1);
    });
    afterAll(async () => {
      jest.useRealTimers();
      await app.close();
    });

    it('devrait redevenir disponible une fois la fenêtre écoulée', async () => {
      const entetes = { 'X-Forwarded-For': '203.0.113.111' };
      const avant = await rafale(app, '/essai/public', TIER_TEST.limit + 1, entetes);
      expect(avant[429]).toBe(1);

      jest.advanceTimersByTime(TIER_TEST.ttl + 1_000);

      const apres = await rafale(app, '/essai/public', 1, entetes);
      expect(apres[200]).toBe(1);
    });
  });
});
