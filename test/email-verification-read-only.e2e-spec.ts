import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { User } from '../src/modules/auth/user.schema';
import { EventsController } from '../src/modules/events/events.controller';
import { EventsService } from '../src/modules/events/events.service';
import { EventMediaService } from '../src/modules/events/event-media.service';
import { EventAccessService } from '../src/modules/events/event-access.service';
import { InvitationsService } from '../src/modules/invitations/invitations.service';
import { TicketOrdersController } from '../src/modules/tickets/orders/ticket-orders.controller';
import { TicketOrdersService } from '../src/modules/tickets/orders/ticket-orders.service';
import { VendorsController } from '../src/modules/vendors/vendors.controller';
import { VendorsService } from '../src/modules/vendors/vendors.service';
import { VenuesController } from '../src/modules/venues/venues.controller';
import { VenuesService } from '../src/modules/venues/venues.service';
import { FavoritesController } from '../src/modules/favorites/favorites.controller';
import { FavoritesService } from '../src/modules/favorites/favorites.service';
import { ReviewsController } from '../src/modules/reviews/reviews.controller';
import { ReviewsService } from '../src/modules/reviews/reviews.service';
import { EventRegistrationController } from '../src/modules/event-registration/event-registration.controller';
import { EventRegistrationService } from '../src/modules/event-registration/event-registration.service';
import { NotificationsController } from '../src/modules/notifications/notifications.controller';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { JwtAuthGuard } from '../src/shared/guards/jwt-auth.guard';
import { RolesGuard } from '../src/shared/guards/roles.guard';
import { AllExceptionsFilter } from '../src/shared/filters/http-exception.filter';

/**
 * Règle produit « courriel non vérifié = lecture seule », prouvée au niveau HTTP.
 *
 * Pile réelle : JwtStrategy (Passport) + JwtAuthGuard + RolesGuard + filtre
 * global, sur les VRAIS controllers. Seuls les services métier et le modèle
 * User sont simulés : le statut de vérification est lu dans ce faux modèle,
 * exactement comme la stratégie le lit en base en production.
 */

const JWT_SECRET = 'e2e-access-secret-0123456789abcdefghij';
const OBJECT_ID = '664f1a2b3c4d5e6f7a8b9c0d';

/** Service simulé : toute méthode résout `{ ok: true }`. */
function autoMock(): Record<string, jest.Mock> {
  return new Proxy({} as Record<string, jest.Mock>, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string' || prop === 'then' || /^(on|before)[A-Z]/.test(prop)) {
        return undefined;
      }
      target[prop] ??= jest.fn().mockResolvedValue({ ok: true });
      return target[prop];
    },
  });
}

type Role = 'participant' | 'organisateur' | 'prestataire' | 'gestionnaire_salle';

describe('Courriel non vérifié = lecture seule (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  /** Faux stockage User : id → isEmailVerified. */
  const users = new Map<string, boolean>();

  beforeAll(async () => {
    const userModel = {
      findById: jest.fn((id: string) => ({
        lean: () => ({
          select: async () =>
            users.has(id) ? { _id: id, isEmailVerified: users.get(id) } : null,
        }),
      })),
    };
    const configService = {
      getOrThrow: (key: string) => (key === 'jwt.secret' ? JWT_SECRET : false),
      get: () => undefined,
    };

    const mockedServices = [
      AuthService, EventsService, EventMediaService, EventAccessService, InvitationsService,
      TicketOrdersService, VendorsService, VenuesService, FavoritesService, ReviewsService,
      EventRegistrationService, NotificationsService,
    ].map((provide) => ({ provide, useValue: autoMock() }));

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({})],
      controllers: [
        AuthController, EventsController, TicketOrdersController, VendorsController,
        VenuesController, FavoritesController, ReviewsController, EventRegistrationController,
        NotificationsController,
      ],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: configService },
        { provide: getModelToken(User.name), useValue: userModel },
        ...mockedServices,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    // Même ordre que main.ts.
    app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => app.close());

  let counter = 0;
  function tokenFor(role: Role, isEmailVerified: boolean): string {
    counter += 1;
    const sub = `664f1a2b3c4d5e6f7a8b${String(counter).padStart(4, '0')}`;
    users.set(sub, isEmailVerified);
    return jwt.sign(
      { sub, email: `${role}${counter}@example.ca`, roles: [role] },
      { secret: JWT_SECRET, algorithm: 'HS256', expiresIn: '5m' },
    );
  }

  type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
  const call = (method: Method, path: string, token: string) =>
    request(app.getHttpServer())[method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'e2e-key-0001')
      .send({});

  const scenarios: Record<Role, { reads: [Method, string][]; writes: [Method, string][] }> = {
    participant: {
      reads: [['get', '/auth/me'], ['get', '/ticket-orders/me'], ['get', '/favorites'], ['get', '/event-registrations/me']],
      writes: [
        ['post', '/ticket-orders'],
        ['post', `/ticket-orders/${OBJECT_ID}/cancel`],
        ['post', '/event-registrations'],
        ['post', '/favorites'],
        ['post', '/reviews'],
        ['patch', '/auth/me/profile'],
      ],
    },
    organisateur: {
      reads: [['get', '/events/my'], ['get', `/events/${OBJECT_ID}`]],
      writes: [
        ['post', '/events'],
        ['patch', `/events/${OBJECT_ID}/publish`],
        ['put', `/events/${OBJECT_ID}`],
        ['delete', `/events/${OBJECT_ID}`],
        ['post', `/vendors/${OBJECT_ID}/requests`],
        ['post', `/venues/${OBJECT_ID}/bookings`],
      ],
    },
    prestataire: {
      reads: [['get', '/vendors/me'], ['get', '/vendors/requests/my']],
      writes: [
        ['post', '/vendors'],
        ['put', '/vendors/me'],
        ['patch', `/vendors/requests/${OBJECT_ID}/respond`],
      ],
    },
    gestionnaire_salle: {
      reads: [['get', '/venues/mine'], ['get', '/venues/bookings/my']],
      writes: [
        ['post', '/venues'],
        ['put', '/venues/me'],
        ['patch', `/venues/bookings/${OBJECT_ID}/respond`],
      ],
    },
  };

  describe.each(Object.keys(scenarios) as Role[])('rôle %s', (role) => {
    const { reads, writes } = scenarios[role];

    it.each(reads)('non vérifié : lecture %s %s autorisée', async (method, path) => {
      const res = await call(method, path, tokenFor(role, false));
      expect(res.status).toBe(200);
    });

    it.each(writes)('non vérifié : écriture %s %s refusée 403 EMAIL_NOT_VERIFIED', async (method, path) => {
      const res = await call(method, path, tokenFor(role, false));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it.each(writes)('vérifié : écriture %s %s passe le guard', async (method, path) => {
      const res = await call(method, path, tokenFor(role, true));
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  });

  it('lit le statut en base : un JWT émis avant la vérification n’est pas bloqué', async () => {
    const token = tokenFor('participant', false);
    await call('post', '/favorites', token).expect(403);
    // L'utilisateur vérifie son courriel ; son access token reste le même.
    const { sub } = jwt.decode<{ sub: string }>(token);
    users.set(sub, true);
    await call('post', '/favorites', token).expect(201);
  });

  it.each<[Method, string, number]>([
    ['post', '/auth/me/resend-verification', 200],
    ['post', '/auth/me/change-password', 200],
    ['patch', '/auth/me/notification-preferences', 200],
    ['patch', '/auth/onboarding/organisateur', 200],
    ['patch', '/notifications/read-all', 204],
    ['patch', `/notifications/${OBJECT_ID}/read`, 204],
  ])('non vérifié : exception justifiée %s %s autorisée', async (method, path, status) => {
    const res = await call(method, path, tokenFor('organisateur', false));
    expect(res.status).toBe(status);
  });

  it('les routes publiques (sans utilisateur) ne sont pas concernées', async () => {
    await request(app.getHttpServer()).post('/auth/logout').send({}).expect(200);
    await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ email: 'x@example.ca' })
      .expect(200);
  });

  it('une requête mutante non authentifiée reste un 401, pas un 403', async () => {
    await request(app.getHttpServer()).post('/favorites').send({}).expect(401);
  });
});
