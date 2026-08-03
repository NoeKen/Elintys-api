import {
  AccessControlledEvent,
  canCheckIn,
  canPurchaseTicket,
  canReceiveInvitation,
  canRegisterForEvent,
  canViewEvent,
  validateEventPublishability,
} from './event-access.policy';
import {
  AdmissionMode,
  EventAccessPolicyType,
  EventDiscoverability,
  EventLocationType,
  EventStatus,
  EventType,
} from './event.schema';

/**
 * Couverture des décisions de politique et de la readiness de publication
 * (findings F-013 — priorités « Policies / Publication / Readiness »).
 */

const ORGANIZER = 'organizer-1';

function event(overrides: Partial<AccessControlledEvent> = {}): AccessControlledEvent {
  return {
    _id: 'event-1',
    organizer: { toString: () => ORGANIZER },
    status: EventStatus.PUBLISHED,
    discoverability: EventDiscoverability.PUBLIC,
    accessPolicy: { type: EventAccessPolicyType.OPEN },
    admissionModes: [AdmissionMode.REGISTRATION_ONLY],
    ...overrides,
  };
}

describe('canRegisterForEvent — une branche par politique', () => {
  it.each([
    ['open, visiteur anonyme', EventAccessPolicyType.OPEN, {}, true, 'OPEN'],
    ['registration_required, connecté', EventAccessPolicyType.REGISTRATION_REQUIRED, { userId: 'u1' }, true, 'AUTHENTICATED'],
    ['registration_required, anonyme', EventAccessPolicyType.REGISTRATION_REQUIRED, {}, false, 'AUTHENTICATION_REQUIRED'],
    ['access_code, avec grant', EventAccessPolicyType.ACCESS_CODE, { accessGrant: true }, true, 'ACCESS_GRANTED'],
    ['access_code, sans grant', EventAccessPolicyType.ACCESS_CODE, {}, false, 'ACCESS_CODE_REQUIRED'],
    ['manual_approval, approuvé', EventAccessPolicyType.MANUAL_APPROVAL, { hasApprovedRequest: true }, true, 'REQUEST_APPROVED'],
    ['manual_approval, non approuvé', EventAccessPolicyType.MANUAL_APPROVAL, {}, false, 'APPROVAL_REQUIRED'],
    ['guest_list, inscrit', EventAccessPolicyType.GUEST_LIST, { isOnGuestList: true }, true, 'ON_GUEST_LIST'],
    ['guest_list, absent', EventAccessPolicyType.GUEST_LIST, {}, false, 'GUEST_LIST_REQUIRED'],
    ['invitation_token, invité', EventAccessPolicyType.INVITATION_TOKEN, { hasInvitation: true }, true, 'INVITATION_VALID'],
    ['invitation_token, non invité', EventAccessPolicyType.INVITATION_TOKEN, {}, false, 'INVITATION_REQUIRED'],
  ])('devrait décider correctement — %s', (_label, type, actor, allowed, reason) => {
    const decision = canRegisterForEvent(actor as never, event({ accessPolicy: { type } }));
    expect(decision).toEqual({ allowed, reason });
  });

  it('devrait autoriser un domaine listé et refuser sinon', () => {
    const policyEvent = event({
      accessPolicy: {
        type: EventAccessPolicyType.EMAIL_DOMAIN,
        allowedDomains: ['elintys.ca'],
      },
    });
    expect(
      canRegisterForEvent(
        { userId: 'u1', email: 'marie@elintys.ca', isEmailVerified: true },
        policyEvent,
      ),
    ).toEqual({ allowed: true, reason: 'EMAIL_DOMAIN_ALLOWED' });
    expect(
      canRegisterForEvent(
        { userId: 'u1', email: 'marie@autre.com', isEmailVerified: true },
        policyEvent,
      ),
    ).toEqual({ allowed: false, reason: 'EMAIL_DOMAIN_NOT_ALLOWED' });
  });

  it('devrait exiger un courriel vérifié pour la politique domaine', () => {
    const policyEvent = event({
      accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['elintys.ca'] },
    });
    expect(
      canRegisterForEvent({ userId: 'u1', email: 'a@elintys.ca', isEmailVerified: false }, policyEvent),
    ).toEqual({ allowed: false, reason: 'VERIFIED_EMAIL_REQUIRED' });
    expect(canRegisterForEvent({ userId: 'u1' }, policyEvent)).toEqual({
      allowed: false,
      reason: 'VERIFIED_EMAIL_REQUIRED',
    });
  });

  it('devrait refuser une politique inconnue', () => {
    expect(
      canRegisterForEvent({ userId: 'u1' }, event({ accessPolicy: { type: 'inconnue' as never } })),
    ).toEqual({ allowed: false, reason: 'ACCESS_POLICY_INVALID' });
  });

  it('devrait refuser l’inscription à un événement privé non visible', () => {
    const decision = canRegisterForEvent({ userId: 'u1' }, event({
      discoverability: EventDiscoverability.PRIVATE,
      accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
    }));
    expect(decision.allowed).toBe(false);
  });
});

describe('canViewEvent', () => {
  it('devrait toujours autoriser le propriétaire, même sur un brouillon', () => {
    expect(
      canViewEvent({ userId: ORGANIZER }, event({ status: EventStatus.DRAFT })),
    ).toEqual({ allowed: true, reason: 'MANAGER' });
  });

  it('devrait autoriser un administrateur', () => {
    expect(canViewEvent({ userId: 'autre', roles: ['admin'] }, event()).allowed).toBe(true);
  });

  it('devrait refuser un événement non publié à un tiers', () => {
    expect(
      canViewEvent({ userId: 'tiers' }, event({ status: EventStatus.DRAFT })),
    ).toEqual({ allowed: false, reason: 'EVENT_NOT_PUBLISHED' });
  });

  it('devrait autoriser la consultation d’un événement unlisted', () => {
    expect(
      canViewEvent({ userId: 'tiers' }, event({ discoverability: EventDiscoverability.UNLISTED })).allowed,
    ).toBe(true);
  });

  it.each([
    ['grant', { accessGrant: true }],
    ['demande approuvée', { hasApprovedRequest: true }],
    ['invitation', { hasInvitation: true }],
    ['liste d’invités', { isOnGuestList: true }],
  ])('devrait autoriser un événement privé avec %s', (_label, actor) => {
    expect(
      canViewEvent({ userId: 'tiers', ...actor }, event({ discoverability: EventDiscoverability.PRIVATE })),
    ).toEqual({ allowed: true, reason: 'PRIVATE_GRANT' });
  });

  it('devrait refuser un événement privé sans aucun droit', () => {
    expect(
      canViewEvent({ userId: 'tiers' }, event({ discoverability: EventDiscoverability.PRIVATE })),
    ).toEqual({ allowed: false, reason: 'PRIVATE_EVENT' });
  });
});

describe('canPurchaseTicket / canReceiveInvitation / canCheckIn', () => {
  it('devrait refuser l’achat si aucun mode billet n’est actif', () => {
    expect(canPurchaseTicket({ userId: 'u1' }, event())).toEqual({
      allowed: false,
      reason: 'TICKET_ADMISSION_DISABLED',
    });
  });

  it('devrait déléguer à la politique quand un mode billet est actif', () => {
    expect(
      canPurchaseTicket({ userId: 'u1' }, event({ admissionModes: [AdmissionMode.PAID_TICKET] })),
    ).toEqual({ allowed: true, reason: 'OPEN' });
  });

  it('devrait refuser l’invitation si le mode invitation est inactif', () => {
    expect(canReceiveInvitation({ userId: ORGANIZER }, event())).toEqual({
      allowed: false,
      reason: 'INVITATION_ADMISSION_DISABLED',
    });
  });

  it('devrait réserver l’envoi d’invitation au propriétaire', () => {
    const invitationEvent = event({ admissionModes: [AdmissionMode.INVITATION] });
    expect(canReceiveInvitation({ userId: ORGANIZER }, invitationEvent).allowed).toBe(true);
    expect(canReceiveInvitation({ userId: 'tiers' }, invitationEvent)).toEqual({
      allowed: false,
      reason: 'EVENT_NOT_OWNER',
    });
  });

  it('devrait autoriser le check-in au gestionnaire ou au porteur d’un billet', () => {
    expect(canCheckIn({ userId: ORGANIZER }, event())).toEqual({ allowed: true, reason: 'EVENT_MANAGER' });
    expect(canCheckIn({ userId: 'tiers', hasValidTicket: true }, event())).toEqual({
      allowed: true,
      reason: 'VALID_TICKET',
    });
    expect(canCheckIn({ userId: 'tiers' }, event())).toEqual({
      allowed: false,
      reason: 'ADMISSION_PROOF_REQUIRED',
    });
  });
});

describe('validateEventPublishability — readiness de publication', () => {
  function publishable(overrides: Partial<AccessControlledEvent> = {}): AccessControlledEvent {
    return event({
      title: 'Sommet Elintys',
      eventType: EventType.CORPORATE,
      startDate: '2026-09-01T18:00:00.000Z',
      accessModelVersion: 2,
      ...overrides,
    });
  }

  it('devrait déclarer publiable un événement complet', () => {
    const result = validateEventPublishability(publishable());
    expect(result.publishable).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['titre manquant', { title: '   ' }, 'TITLE_REQUIRED'],
    ['type manquant', { eventType: undefined }, 'EVENT_TYPE_REQUIRED'],
    ['date de début manquante', { startDate: undefined }, 'START_DATE_REQUIRED'],
  ])('devrait bloquer la publication — %s', (_label, overrides, code) => {
    const result = validateEventPublishability(publishable(overrides));
    expect(result.publishable).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(code);
  });

  it('devrait refuser une date de fin antérieure au début', () => {
    const result = validateEventPublishability(
      publishable({ endDate: '2026-08-01T18:00:00.000Z' }),
    );
    expect(result.errors.map((e) => e.code)).toContain('END_BEFORE_START');
  });

  it('devrait exiger un lieu pour un événement physique', () => {
    const result = validateEventPublishability(
      publishable({ location: { type: EventLocationType.PHYSICAL } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('PHYSICAL_LOCATION_REQUIRED');
  });

  it('devrait accepter un lieu physique nommé', () => {
    const result = validateEventPublishability(
      publishable({ location: { type: EventLocationType.PHYSICAL, name: 'Salle A' } }),
    );
    expect(result.publishable).toBe(true);
  });

  it('devrait avertir (sans bloquer) si l’URL en ligne manque', () => {
    const result = validateEventPublishability(
      publishable({ location: { type: EventLocationType.ONLINE } }),
    );
    expect(result.publishable).toBe(true);
    expect(result.warnings).toContain('ONLINE_URL_MISSING');
  });

  it('devrait exiger un type de billet gratuit quand le mode free_ticket est actif', () => {
    const result = validateEventPublishability(
      publishable({ admissionModes: [AdmissionMode.FREE_TICKET] }),
    );
    expect(result.errors.map((e) => e.code)).toContain('FREE_TICKET_TYPE_REQUIRED');
  });

  it('devrait exiger un type de billet payant quand le mode paid_ticket est actif', () => {
    const result = validateEventPublishability(
      publishable({ admissionModes: [AdmissionMode.PAID_TICKET] }),
    );
    expect(result.errors.map((e) => e.code)).toContain('PAID_TICKET_TYPE_REQUIRED');
  });

  it('devrait accepter les modes billet si l’inventaire est fourni', () => {
    const result = validateEventPublishability(
      publishable({ admissionModes: [AdmissionMode.FREE_TICKET, AdmissionMode.PAID_TICKET] }),
      { freeTicketTypes: 1, paidTicketTypes: 2 },
    );
    expect(result.publishable).toBe(true);
  });

  it('devrait exiger la migration d’un code d’accès legacy', () => {
    const result = validateEventPublishability(
      publishable({ accessModelVersion: 1, accessRules: { accessCode: true } }),
    );
    expect(result.errors.map((e) => e.code)).toContain('LEGACY_ACCESS_CODE_REQUIRES_MIGRATION');
  });

  it('devrait dédupliquer les erreurs identiques', () => {
    const result = validateEventPublishability(
      publishable({ title: '', accessPolicy: undefined, admissionModes: [] }),
    );
    const keys = result.errors.map((e) => `${e.code}:${e.field}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
