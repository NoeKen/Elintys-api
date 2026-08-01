import {
  canCheckIn,
  canPurchaseTicket,
  canRegisterForEvent,
  canViewEvent,
  isAllowedEmailDomain,
  normalizeLegacyEventAccess,
  validateEventAccessConfiguration,
  validateEventPublishability,
} from './event-access.policy';
import {
  AdmissionMode,
  EventAccessPolicyType,
  EventDiscoverability,
  EventLocationType,
  EventStatus,
  EventType,
  EventVisibility,
} from './event.schema';

const baseEvent = {
  title: 'Gala Elintys',
  eventType: EventType.GALA,
  startDate: '2026-09-10T18:00:00.000Z',
  status: EventStatus.PUBLISHED,
  discoverability: EventDiscoverability.PUBLIC,
  accessPolicy: { type: EventAccessPolicyType.OPEN },
  admissionModes: [AdmissionMode.FREE],
  location: { type: EventLocationType.PHYSICAL, name: 'Maison Saint-Laurent' },
};

describe('event access policies', () => {
  it('supporte les matrices public libre et billets + invitations', () => {
    expect(validateEventAccessConfiguration(baseEvent)).toEqual({ valid: true, errors: [] });
    expect(validateEventAccessConfiguration({
      ...baseEvent,
      admissionModes: [AdmissionMode.PAID_TICKET, AdmissionMode.INVITATION],
    }).valid).toBe(true);
  });

  it('refuse un événement privé ouvert et une invitation sans admission invitation', () => {
    expect(validateEventAccessConfiguration({
      ...baseEvent,
      discoverability: EventDiscoverability.PRIVATE,
    }).errors).toContainEqual(expect.objectContaining({ code: 'PRIVATE_EVENT_REQUIRES_RESTRICTION' }));
    expect(validateEventAccessConfiguration({
      ...baseEvent,
      accessPolicy: { type: EventAccessPolicyType.INVITATION_TOKEN },
    }).errors).toContainEqual(expect.objectContaining({ code: 'INVITATION_ADMISSION_REQUIRED' }));
  });

  it('refuse code absent et domaines invalides', () => {
    expect(validateEventAccessConfiguration({
      ...baseEvent,
      accessPolicy: { type: EventAccessPolicyType.ACCESS_CODE },
    }).errors).toContainEqual(expect.objectContaining({ code: 'ACCESS_CODE_REQUIRED' }));
    expect(validateEventAccessConfiguration({
      ...baseEvent,
      accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['evil_entreprise.ca'] },
    }).errors).toContainEqual(expect.objectContaining({ code: 'ALLOWED_DOMAIN_INVALID' }));
  });

  it('compare le domaine final exactement et exige une adresse syntaxiquement valide', () => {
    expect(isAllowedEmailDomain('lea@entreprise.ca', ['entreprise.ca'])).toBe(true);
    expect(isAllowedEmailDomain('lea@evilentreprise.ca', ['entreprise.ca'])).toBe(false);
    expect(isAllowedEmailDomain('lea@sous.entreprise.ca', ['entreprise.ca'])).toBe(false);
    expect(isAllowedEmailDomain('invalid', ['entreprise.ca'])).toBe(false);
  });

  it('distingue lecture, inscription, achat et check-in', () => {
    const restricted = {
      ...baseEvent,
      accessPolicy: {
        type: EventAccessPolicyType.EMAIL_DOMAIN,
        allowedDomains: ['entreprise.ca'],
        requiresAuthentication: true,
      },
      admissionModes: [AdmissionMode.PAID_TICKET],
    };
    expect(canViewEvent({}, restricted).allowed).toBe(true);
    expect(canRegisterForEvent({}, restricted).reason).toBe('VERIFIED_EMAIL_REQUIRED');
    expect(canRegisterForEvent({ userId: 'u1', email: 'lea@entreprise.ca', isEmailVerified: true }, restricted).allowed).toBe(true);
    expect(canPurchaseTicket({ userId: 'u1', email: 'lea@entreprise.ca', isEmailVerified: true }, restricted).allowed).toBe(true);
    expect(canCheckIn({}, restricted).reason).toBe('ADMISSION_PROOF_REQUIRED');
    expect(canCheckIn({ hasValidTicket: true }, restricted).allowed).toBe(true);
  });

  it('ne rend pas un événement privé visible sans grant', () => {
    const privateEvent = {
      ...baseEvent,
      discoverability: EventDiscoverability.PRIVATE,
      accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
    };
    expect(canViewEvent({}, privateEvent).allowed).toBe(false);
    expect(canViewEvent({ hasApprovedRequest: true }, privateEvent).allowed).toBe(true);
  });

  it('valide la readiness et exige les types de billets', () => {
    const result = validateEventPublishability(
      { ...baseEvent, admissionModes: [AdmissionMode.PAID_TICKET] },
      { freeTicketTypes: 0, paidTicketTypes: 0 },
    );
    expect(result.publishable).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'PAID_TICKET_TYPE_REQUIRED', field: 'ticketTypes' }));
  });

  it('bloque la publication d’un ancien code privé dont la valeur brute est irrécupérable', () => {
    const result = validateEventPublishability({
      ...baseEvent,
      accessModelVersion: 1,
      accessRules: { accessCode: true },
    });
    expect(result.publishable).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'LEGACY_ACCESS_CODE_REQUIRES_MIGRATION' }));
  });

  it('normalise temporairement les événements legacy sans confondre invitation et visibilité publique', () => {
    expect(normalizeLegacyEventAccess({ visibility: EventVisibility.INVITE_ONLY }).discoverability)
      .toBe(EventDiscoverability.UNLISTED);
    expect(normalizeLegacyEventAccess({ visibility: EventVisibility.PUBLIC }).accessPolicy.type)
      .toBe(EventAccessPolicyType.OPEN);
  });
});
