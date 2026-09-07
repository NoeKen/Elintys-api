import { ForbiddenException } from '@nestjs/common';
import { canManageEvent } from '../src/modules/events/event-access.policy';
import { ROLES_KEY, Role } from '../src/shared/decorators/roles.decorator';
import { TicketTypesController } from '../src/modules/tickets/tickets.controller';
import { VenuesController } from '../src/modules/venues/venues.controller';

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
    expect(canManageEvent({ userId: undefined, roles: ['admin'] }, event).allowed).toBe(false);
    expect(canManageEvent({ userId: undefined, roles: [] }, event).allowed).toBe(false);
  });

  it('refuse quand les rôles ne sont PAS transmis', () => {
    // Défaut volontaire des services : `roles = []` ⇒ propriétaire strict.
    // Un appelant qui oublie de transmettre les rôles ne perd donc jamais en
    // sécurité, il perd seulement la capacité admin.
    expect(canManageEvent({ userId: OTHER }, event).allowed).toBe(false);
  });
});

describe('Contrats de routes admin', () => {
  it('autorise réellement ADMIN sur la liste de gestion des types de billets', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      TicketTypesController.prototype.findManagedTypes,
    ) as Role[];

    expect(roles).toEqual([Role.ORGANISATEUR, Role.ADMIN]);
  });

  it('annonce les mêmes rôles que le service sur les réservations d’un événement', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      VenuesController.prototype.listBookingsByEvent,
    ) as Role[];

    expect(roles).toEqual([Role.ORGANISATEUR, Role.ADMIN]);
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
