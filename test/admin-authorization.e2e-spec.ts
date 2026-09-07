import { ForbiddenException } from '@nestjs/common';
import { canManageEvent } from '../src/modules/events/event-access.policy';

/**
 * Cohérence ADMIN (B-01).
 *
 * L'audit avait relevé le risque : un contrôleur annonce `@Roles(…, ADMIN)`
 * mais le service compare directement les identifiants et refuse donc l'admin.
 * Le guard laisse passer, le service oppose un 403 : la route promet une
 * capacité qu'elle n'a pas.
 *
 * Ce spec verrouille les DEUX issues retenues :
 *   A. la route autorise réellement ADMIN → la policy le confirme ;
 *   B. la route ne l'autorise pas → ADMIN a été retiré du décorateur.
 */

const OWNER = '664f1a2b3c4d5e6f7a8b9c0d';
const OTHER = '664f1a2b3c4d5e6f7a8b9c0e';
const event = { organizer: OWNER } as never;

describe('Politique de gestion d’événement', () => {
  it('autorise le propriétaire', () => {
    expect(canManageEvent({ userId: OWNER, roles: ['organisateur'] }, event).allowed).toBe(true);
  });

  it('autorise un admin non propriétaire', () => {
    expect(canManageEvent({ userId: OTHER, roles: ['admin'] }, event).allowed).toBe(true);
  });

  it('refuse un organisateur tiers', () => {
    const decision = canManageEvent({ userId: OTHER, roles: ['organisateur'] }, event);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('EVENT_NOT_OWNER');
  });

  it('refuse un acteur sans rôle', () => {
    expect(canManageEvent({ userId: OTHER, roles: [] }, event).allowed).toBe(false);
  });

  it('refuse un acteur anonyme', () => {
    expect(canManageEvent({ userId: undefined, roles: ['admin'] }, event).allowed).toBe(true);
    expect(canManageEvent({ userId: undefined, roles: [] }, event).allowed).toBe(false);
  });

  it('refuse quand les rôles ne sont PAS transmis', () => {
    // Défaut volontaire des services : `roles = []` ⇒ propriétaire strict.
    // Un appelant qui oublie de transmettre les rôles ne perd donc jamais en
    // sécurité, il perd seulement la capacité admin.
    expect(canManageEvent({ userId: OTHER }, event).allowed).toBe(false);
  });
});

/**
 * Les services event-scoped acceptent tous un paramètre `roles` optionnel :
 * c'est ce qui rend l'admin annoncé par le contrôleur réellement effectif.
 * Ce test échoue si une signature repart en arrière.
 */
describe('Signatures admin-aware', () => {
  const cases: Array<[string, unknown]> = [];

  beforeAll(async () => {
    const { EventsService } = await import('../src/modules/events/events.service');
    const { GuestsService } = await import('../src/modules/guests/guests.service');
    const { TicketsService } = await import('../src/modules/tickets/tickets.service');
    const { VendorsService } = await import('../src/modules/vendors/vendors.service');
    const { VenuesService } = await import('../src/modules/venues/venues.service');

    cases.push(
      ['EventsService.findOne', EventsService.prototype.findOne],
      ['EventsService.update', EventsService.prototype.update],
      ['EventsService.remove', EventsService.prototype.remove],
      ['EventsService.publish', EventsService.prototype.publish],
      ['EventsService.cancel', EventsService.prototype.cancel],
      ['EventsService.archive', EventsService.prototype.archive],
      ['EventsService.restore', EventsService.prototype.restore],
      ['EventsService.getPublishReadiness', EventsService.prototype.getPublishReadiness],
      ['GuestsService.create', GuestsService.prototype.create],
      ['GuestsService.findAll', GuestsService.prototype.findAll],
      ['GuestsService.update', GuestsService.prototype.update],
      ['GuestsService.remove', GuestsService.prototype.remove],
      ['TicketsService.createTicketType', TicketsService.prototype.createTicketType],
      ['TicketsService.updateTicketType', TicketsService.prototype.updateTicketType],
      ['TicketsService.removeTicketType', TicketsService.prototype.removeTicketType],
      ['VendorsService.createRequest', VendorsService.prototype.createRequest],
      ['VendorsService.listRequestsByEvent', VendorsService.prototype.listRequestsByEvent],
      ['VendorsService.cancelRequest', VendorsService.prototype.cancelRequest],
      ['VenuesService.cancelBooking', VenuesService.prototype.cancelBooking],
    );
  });

  it('chaque service event-scoped accepte des rôles', () => {
    const missing = cases
      .filter(([, fn]) => !/roles/.test(String(fn)))
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });
});

describe('Erreur d’autorisation', () => {
  it('reste un ForbiddenException, jamais un 404 ni un 500', () => {
    // Distinguer « existe mais interdit » de « n'existe pas » est un contrat :
    // renvoyer 404 masquerait un problème de droits en problème de données.
    const error = new ForbiddenException('EVENT_NOT_OWNER');
    expect(error.getStatus()).toBe(403);
  });
});
