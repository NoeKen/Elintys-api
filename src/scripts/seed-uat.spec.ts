import mongoose, { Connection, Schema } from 'mongoose';
import { validateEventPublishability } from '../modules/events/event-access.policy';
import { AdmissionMode, EventDiscoverability, EventLocationType, EventStatus } from '../modules/events/event.schema';
import {
  UAT_ACCOUNTS,
  UAT_EMAIL_DOMAIN,
  UAT_EVENTS,
  assertSeedPassword,
  resolveUatConnection,
  seedUatDatabase,
} from './seed-uat';

interface RecordedWrite {
  model: string;
  filter: Record<string, unknown>;
  document: Record<string, unknown>;
}

/**
 * Connexion factice : chaque upsert est matérialisé avec le VRAI schéma Mongoose
 * et validé (`validateSync`) — sans base de données.
 */
function recordingConnection(writes: RecordedWrite[]): Connection {
  const validator = mongoose.createConnection();
  return {
    model: (name: string, schema: Schema) => {
      const Real = validator.models[name] ?? validator.model(name, schema);
      return {
        findOneAndUpdate: jest.fn(async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
          const doc = new Real({ ...filter, ...update.$setOnInsert, ...update.$set });
          const error = doc.validateSync();
          if (error) throw error;
          writes.push({ model: name, filter, document: doc.toObject() as Record<string, unknown> });
          return { _id: doc._id };
        }),
        updateOne: jest.fn(async () => ({ matchedCount: 1 })),
        countDocuments: jest.fn(async () => 0),
      };
    },
  } as unknown as Connection;
}

describe('seed UAT — gardes', () => {
  const uatUri = 'mongodb+srv://user:pw@cluster0.example.mongodb.net/elintys-uat?retryWrites=true';

  it('devrait accepter uniquement ELINTYS_ENV=uat avec la base elintys-uat', () => {
    expect(resolveUatConnection({ ELINTYS_ENV: 'uat', MONGODB_URI: uatUri })).toMatchObject({
      clusterHost: 'cluster0.example.mongodb.net',
      target: { environment: 'uat', databaseName: 'elintys-uat' },
    });
  });

  it.each([
    [{ ELINTYS_ENV: 'prod', MONGODB_URI: uatUri }, 'UAT_ENVIRONMENT_REQUIRED'],
    [{ ELINTYS_ENV: 'dev', MONGODB_URI: uatUri }, 'UAT_ENVIRONMENT_REQUIRED'],
    [{ ELINTYS_ENV: 'uat', MONGODB_URI: 'mongodb://h/elintys-dev' }, 'UAT_DATABASE_REQUIRED'],
    [{ ELINTYS_ENV: 'uat', MONGODB_URI: 'mongodb://h/elintys' }, 'UAT_DATABASE_REQUIRED'],
    [{ ELINTYS_ENV: 'uat', MONGODB_URI: 'mongodb://h/elintys-prod' }, 'PRODUCTION_DATABASE_REFUSED'],
    [{ ELINTYS_ENV: 'uat' }, 'MONGODB_URI_REQUIRED'],
  ])('devrait refuser %j', (env, code) => {
    expect(() => resolveUatConnection(env)).toThrow(code);
  });

  it('devrait exiger un mot de passe fort sans jamais le renvoyer dans l’erreur', () => {
    expect(() => assertSeedPassword(undefined)).toThrow('UAT_SEED_PASSWORD_REQUIRED');
    expect(() => assertSeedPassword('short-pw')).toThrow('UAT_SEED_PASSWORD_TOO_SHORT');
    expect(() => assertSeedPassword('x'.repeat(73))).toThrow('UAT_SEED_PASSWORD_TOO_LONG');
    try {
      assertSeedPassword('short-pw');
    } catch (error) {
      expect((error as Error).message).not.toContain('short-pw');
    }
    expect(assertSeedPassword('Recette-UAT-2026!')).toBe('Recette-UAT-2026!');
  });
});

describe('seed UAT — données', () => {
  it('devrait ne contenir que des comptes fictifs sur le domaine de test', () => {
    expect(new Set(UAT_ACCOUNTS.map((a) => a.email)).size).toBe(UAT_ACCOUNTS.length);
    expect(UAT_ACCOUNTS.every((a) => a.email.endsWith(`@${UAT_EMAIL_DOMAIN}`))).toBe(true);
    expect(UAT_ACCOUNTS.filter((a) => !a.verified).map((a) => a.key)).toEqual(['participant-unverified']);
    for (const key of ['participant-a', 'participant-b', 'organizer-a', 'organizer-b', 'vendor-a', 'vendor-b', 'venue-manager-a', 'venue-manager-b']) {
      expect(UAT_ACCOUNTS.some((a) => a.key === key && a.verified)).toBe(true);
    }
  });

  it('devrait couvrir tous les états d’événement demandés avec des configurations publiables', () => {
    const statuses = new Set(UAT_EVENTS.map((e) => e.status));
    const discoverabilities = new Set(UAT_EVENTS.map((e) => e.discoverability));
    expect(statuses).toEqual(new Set([EventStatus.PUBLISHED, EventStatus.DRAFT, EventStatus.COMPLETED, EventStatus.CANCELLED]));
    expect(discoverabilities).toEqual(new Set([EventDiscoverability.PUBLIC, EventDiscoverability.UNLISTED, EventDiscoverability.PRIVATE]));
    for (const event of UAT_EVENTS) {
      const result = validateEventPublishability(
        { ...event, title: event.title, location: { type: EventLocationType.PHYSICAL, name: event.venueName ?? 'Lieu à confirmer' }, accessModelVersion: 2 },
        {
          freeTicketTypes: event.ticketTypes.filter((t) => t.isFree).length,
          paidTicketTypes: event.ticketTypes.filter((t) => !t.isFree).length,
        },
      );
      expect({ slug: event.slug, errors: result.errors }).toEqual({ slug: event.slug, errors: [] });
    }
    const paid = UAT_EVENTS.flatMap((e) => e.ticketTypes).filter((t) => !t.isFree);
    expect(paid.length).toBeGreaterThan(0);
    expect(UAT_EVENTS.some((e) => e.admissionModes.includes(AdmissionMode.FREE_TICKET))).toBe(true);
  });

  it('devrait produire uniquement des documents valides selon les schémas, par clés stables', async () => {
    const first: RecordedWrite[] = [];
    const second: RecordedWrite[] = [];
    const summary = await seedUatDatabase(recordingConnection(first), 'Recette-UAT-2026!');
    await seedUatDatabase(recordingConnection(second), 'Recette-UAT-2026!');

    const byModel = (writes: RecordedWrite[], model: string) => writes.filter((w) => w.model === model);
    expect(byModel(first, 'User')).toHaveLength(9);
    expect(byModel(first, 'Event')).toHaveLength(UAT_EVENTS.length);
    expect(byModel(first, 'VenueProfile')).toHaveLength(3);
    expect(byModel(first, 'VendorProfile')).toHaveLength(2);
    expect(byModel(first, 'Review')).toHaveLength(4);
    expect(byModel(first, 'Guest')).toHaveLength(3);
    expect(byModel(first, 'Invitation')).toHaveLength(2);
    expect(byModel(first, 'TicketType').map((w) => w.document.isFree)).toEqual(expect.arrayContaining([true, false]));

    // Idempotence : filtres fonctionnels identiques d'une exécution à l'autre pour les clés naturelles.
    const naturalKeys = (writes: RecordedWrite[]) =>
      writes
        .filter((w) => ['User', 'Event'].includes(w.model))
        .map((w) => JSON.stringify(w.filter));
    expect(naturalKeys(second)).toEqual(naturalKeys(first));

    // Le mot de passe n'apparaît jamais en clair ; seul un hash bcrypt est écrit.
    const users = byModel(first, 'User');
    expect(users.every((w) => String(w.document.password).startsWith('$2'))).toBe(true);
    expect(JSON.stringify(first)).not.toContain('Recette-UAT-2026!');
    expect(JSON.stringify(summary)).not.toContain('Recette-UAT-2026!');
    expect(summary.accounts.every((a) => a.email.endsWith(`@${UAT_EMAIL_DOMAIN}`))).toBe(true);

    // Aucun courriel hors domaine de test dans les documents écrits.
    const emails = JSON.stringify(first).match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.filter((e) => !e.endsWith(UAT_EMAIL_DOMAIN))).toEqual([]);
  });
});
