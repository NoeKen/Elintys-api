import {
  AdmissionMode,
  EventAccessPolicy,
  EventAccessPolicyType,
  EventDiscoverability,
  EventLocationType,
  EventStatus,
  EventType,
  EventVisibility,
} from './event.schema';

const ASCII_DOMAIN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface AccessControlledEvent {
  _id?: unknown;
  organizer?: { toString(): string } | string;
  title?: string;
  eventType?: EventType;
  startDate?: Date | string;
  endDate?: Date | string;
  status?: EventStatus;
  discoverability?: EventDiscoverability;
  accessPolicy?: EventAccessPolicy;
  admissionModes?: AdmissionMode[];
  location?: { type?: EventLocationType; name?: string; address?: string; onlineUrl?: string };
  visibility?: EventVisibility;
  accessRules?: { accessCode?: boolean; allowedEmailDomain?: string; manualApproval?: boolean };
  accessModelVersion?: number;
}

export interface EventActor {
  userId?: string | null;
  email?: string | null;
  isEmailVerified?: boolean;
  roles?: string[];
  accessGrant?: boolean;
  hasApprovedRequest?: boolean;
  isOnGuestList?: boolean;
  hasInvitation?: boolean;
  hasValidTicket?: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface PublishabilityResult {
  publishable: boolean;
  errors: EventValidationError[];
  warnings: string[];
}

export interface EventValidationError {
  code: string;
  field: string;
}

/** Forme d'accès V2 résolue à partir d'un document legacy. */
export interface LegacyAccessShape {
  discoverability: EventDiscoverability;
  accessPolicy: EventAccessPolicy;
  admissionModes: AdmissionMode[];
}

export type LegacyAmbiguityReason =
  | 'ACCESS_CODE_MISSING_RAW_VALUE'
  | 'PRIVATE_INTENT_UNDETERMINED';

/**
 * `mapped`    : intention legacy déterminée — persistable par la migration.
 * `ambiguous` : intention indéterminable — la migration NE persiste PAS, mais
 *               `fallback` donne le comportement runtime appliqué en attendant
 *               (identique à l'historique, donc aucun changement de comportement).
 */
export type LegacyAccessMapping =
  | { status: 'mapped'; value: LegacyAccessShape }
  | { status: 'ambiguous'; reason: LegacyAmbiguityReason; fallback: LegacyAccessShape };

type LegacyAccessSource = Pick<AccessControlledEvent, 'visibility' | 'accessRules'>;

const PUBLIC_SHAPE: LegacyAccessShape = {
  discoverability: EventDiscoverability.PUBLIC,
  accessPolicy: { type: EventAccessPolicyType.OPEN },
  admissionModes: [AdmissionMode.REGISTRATION_ONLY],
};

const INVITE_ONLY_SHAPE: LegacyAccessShape = {
  discoverability: EventDiscoverability.UNLISTED,
  accessPolicy: { type: EventAccessPolicyType.INVITATION_TOKEN },
  admissionModes: [AdmissionMode.INVITATION],
};

const MANUAL_APPROVAL_SHAPE: LegacyAccessShape = {
  discoverability: EventDiscoverability.PRIVATE,
  accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL, requiresAuthentication: true },
  admissionModes: [AdmissionMode.REGISTRATION_ONLY],
};

const REGISTRATION_REQUIRED_SHAPE: LegacyAccessShape = {
  discoverability: EventDiscoverability.PRIVATE,
  accessPolicy: { type: EventAccessPolicyType.REGISTRATION_REQUIRED, requiresAuthentication: true },
  admissionModes: [AdmissionMode.REGISTRATION_ONLY],
};

function emailDomainShape(allowedEmailDomain: string): LegacyAccessShape {
  return {
    discoverability: EventDiscoverability.UNLISTED,
    accessPolicy: {
      type: EventAccessPolicyType.EMAIL_DOMAIN,
      requiresAuthentication: true,
      allowedDomains: [normalizeDomain(allowedEmailDomain)],
    },
    admissionModes: [AdmissionMode.REGISTRATION_ONLY],
  };
}

/**
 * **Source de vérité unique** du mapping legacy → Access V2 (finding F-027).
 *
 * Utilisée par la normalisation runtime (`normalizeLegacyEventAccess`) ET par le
 * script de migration (`migrate-event-access-v2.ts`) : aucune logique dupliquée,
 * donc aucune divergence possible.
 *
 * Priorité = **restriction la plus forte d'abord**. En particulier
 * `manualApproval` prime sur `allowedEmailDomain` : un événement privé à
 * approbation manuelle ne doit JAMAIS être dégradé en `unlisted + email_domain`.
 */
export function mapLegacyEventAccessToV2(event: LegacyAccessSource): LegacyAccessMapping {
  if (!event.visibility || event.visibility === EventVisibility.PUBLIC) {
    return { status: 'mapped', value: PUBLIC_SHAPE };
  }
  if (event.visibility === EventVisibility.INVITE_ONLY) {
    return { status: 'mapped', value: INVITE_ONLY_SHAPE };
  }

  // visibility = private (ou valeur inconnue) : chaîne par restriction décroissante.
  const rules = event.accessRules;
  const restrictive: LegacyAccessShape = rules?.manualApproval
    ? MANUAL_APPROVAL_SHAPE
    : rules?.allowedEmailDomain
      ? emailDomainShape(rules.allowedEmailDomain)
      : REGISTRATION_REQUIRED_SHAPE;

  // Le code d'accès brut n'est pas récupérable (seul un hash pourrait être stocké) :
  // on refuse de persister pour ne pas perdre silencieusement l'exigence de code.
  if (rules?.accessCode) {
    return {
      status: 'ambiguous',
      reason: 'ACCESS_CODE_MISSING_RAW_VALUE',
      fallback: restrictive,
    };
  }
  if (rules?.manualApproval || rules?.allowedEmailDomain) {
    return { status: 'mapped', value: restrictive };
  }
  return {
    status: 'ambiguous',
    reason: 'PRIVATE_INTENT_UNDETERMINED',
    fallback: REGISTRATION_REQUIRED_SHAPE,
  };
}

/** Résout la forme d'accès effective (mapping retenu, ou repli si ambigu). */
export function resolveLegacyAccessShape(event: LegacyAccessSource): LegacyAccessShape {
  const mapping = mapLegacyEventAccessToV2(event);
  return mapping.status === 'mapped' ? mapping.value : mapping.fallback;
}

/** Compatibilité temporaire à supprimer après migration complète vers accessModelVersion=2. */
export function normalizeLegacyEventAccess<T extends AccessControlledEvent>(event: T): T & {
  discoverability: EventDiscoverability;
  accessPolicy: EventAccessPolicy;
  admissionModes: AdmissionMode[];
} {
  if (event.discoverability && event.accessPolicy && event.admissionModes?.length) {
    return event as T & { discoverability: EventDiscoverability; accessPolicy: EventAccessPolicy; admissionModes: AdmissionMode[] };
  }
  return { ...event, ...resolveLegacyAccessShape(event) };
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

export function isAllowedEmailDomain(email: string, allowedDomains: string[]): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalizedEmail)) return false;
  const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
  if (!ASCII_DOMAIN.test(domain)) return false;
  return allowedDomains.map(normalizeDomain).some((allowed) => ASCII_DOMAIN.test(allowed) && allowed === domain);
}

export function validateEventAccessConfiguration(
  event: AccessControlledEvent,
): { valid: boolean; errors: EventValidationError[] } {
  const errors: EventValidationError[] = [];
  const discoverability = event.discoverability;
  const policy = event.accessPolicy;
  const modes = event.admissionModes ?? [];

  if (!discoverability || !Object.values(EventDiscoverability).includes(discoverability)) {
    errors.push({ code: 'DISCOVERABILITY_REQUIRED', field: 'discoverability' });
  }
  if (!policy?.type || !Object.values(EventAccessPolicyType).includes(policy.type)) {
    errors.push({ code: 'ACCESS_POLICY_REQUIRED', field: 'accessPolicy' });
  }
  if (modes.length === 0) errors.push({ code: 'ADMISSION_MODE_REQUIRED', field: 'admissionModes' });

  if (policy?.type === EventAccessPolicyType.ACCESS_CODE && !policy.codeHash) {
    errors.push({ code: 'ACCESS_CODE_REQUIRED', field: 'accessPolicy' });
  }
  if (policy?.type === EventAccessPolicyType.EMAIL_DOMAIN) {
    const domains = policy.allowedDomains ?? [];
    if (domains.length === 0) errors.push({ code: 'ALLOWED_DOMAIN_REQUIRED', field: 'accessPolicy.allowedDomains' });
    if (domains.some((domain) => !ASCII_DOMAIN.test(normalizeDomain(domain)))) {
      errors.push({ code: 'ALLOWED_DOMAIN_INVALID', field: 'accessPolicy.allowedDomains' });
    }
  }
  if (
    policy?.type === EventAccessPolicyType.INVITATION_TOKEN &&
    !modes.includes(AdmissionMode.INVITATION)
  ) {
    errors.push({ code: 'INVITATION_ADMISSION_REQUIRED', field: 'admissionModes' });
  }
  if (discoverability === EventDiscoverability.PRIVATE && policy?.type === EventAccessPolicyType.OPEN) {
    errors.push({ code: 'PRIVATE_EVENT_REQUIRES_RESTRICTION', field: 'accessPolicy' });
  }

  return { valid: errors.length === 0, errors };
}

export function canManageEvent(actor: EventActor, event: AccessControlledEvent): PolicyDecision {
  if (actor.roles?.includes('admin')) return { allowed: true, reason: 'ADMIN' };
  const organizerId = event.organizer?.toString();
  return actor.userId && organizerId === actor.userId
    ? { allowed: true, reason: 'OWNER' }
    : { allowed: false, reason: 'EVENT_NOT_OWNER' };
}

export function canViewEvent(actor: EventActor, event: AccessControlledEvent): PolicyDecision {
  if (canManageEvent(actor, event).allowed) return { allowed: true, reason: 'MANAGER' };
  if (event.status !== EventStatus.PUBLISHED) return { allowed: false, reason: 'EVENT_NOT_PUBLISHED' };
  if (event.discoverability !== EventDiscoverability.PRIVATE) return { allowed: true, reason: 'PUBLIC_DETAILS' };
  if (actor.accessGrant || actor.hasApprovedRequest || actor.hasInvitation || actor.isOnGuestList) {
    return { allowed: true, reason: 'PRIVATE_GRANT' };
  }
  return { allowed: false, reason: 'PRIVATE_EVENT' };
}

export function canRegisterForEvent(actor: EventActor, event: AccessControlledEvent): PolicyDecision {
  if (!canViewEvent(actor, event).allowed && event.discoverability === EventDiscoverability.PRIVATE) {
    return { allowed: false, reason: 'EVENT_NOT_VIEWABLE' };
  }
  const policy = event.accessPolicy;
  switch (policy?.type) {
    case EventAccessPolicyType.OPEN:
      return { allowed: true, reason: 'OPEN' };
    case EventAccessPolicyType.REGISTRATION_REQUIRED:
      return actor.userId ? { allowed: true, reason: 'AUTHENTICATED' } : { allowed: false, reason: 'AUTHENTICATION_REQUIRED' };
    case EventAccessPolicyType.ACCESS_CODE:
      return actor.accessGrant ? { allowed: true, reason: 'ACCESS_GRANTED' } : { allowed: false, reason: 'ACCESS_CODE_REQUIRED' };
    case EventAccessPolicyType.EMAIL_DOMAIN:
      if (!actor.userId || !actor.isEmailVerified || !actor.email) return { allowed: false, reason: 'VERIFIED_EMAIL_REQUIRED' };
      return isAllowedEmailDomain(actor.email, policy.allowedDomains ?? [])
        ? { allowed: true, reason: 'EMAIL_DOMAIN_ALLOWED' }
        : { allowed: false, reason: 'EMAIL_DOMAIN_NOT_ALLOWED' };
    case EventAccessPolicyType.MANUAL_APPROVAL:
      return actor.hasApprovedRequest ? { allowed: true, reason: 'REQUEST_APPROVED' } : { allowed: false, reason: 'APPROVAL_REQUIRED' };
    case EventAccessPolicyType.GUEST_LIST:
      return actor.isOnGuestList ? { allowed: true, reason: 'ON_GUEST_LIST' } : { allowed: false, reason: 'GUEST_LIST_REQUIRED' };
    case EventAccessPolicyType.INVITATION_TOKEN:
      return actor.hasInvitation ? { allowed: true, reason: 'INVITATION_VALID' } : { allowed: false, reason: 'INVITATION_REQUIRED' };
    default:
      return { allowed: false, reason: 'ACCESS_POLICY_INVALID' };
  }
}

export function canPurchaseTicket(actor: EventActor, event: AccessControlledEvent): PolicyDecision {
  if (!(event.admissionModes ?? []).some((mode) => mode === AdmissionMode.FREE_TICKET || mode === AdmissionMode.PAID_TICKET)) {
    return { allowed: false, reason: 'TICKET_ADMISSION_DISABLED' };
  }
  return canRegisterForEvent(actor, event);
}

export function canReceiveInvitation(actor: EventActor, event: AccessControlledEvent): PolicyDecision {
  if (!(event.admissionModes ?? []).includes(AdmissionMode.INVITATION)) {
    return { allowed: false, reason: 'INVITATION_ADMISSION_DISABLED' };
  }
  return canManageEvent(actor, event);
}

export function canCheckIn(actor: EventActor, event: AccessControlledEvent): PolicyDecision {
  if (canManageEvent(actor, event).allowed) return { allowed: true, reason: 'EVENT_MANAGER' };
  return actor.hasValidTicket ? { allowed: true, reason: 'VALID_TICKET' } : { allowed: false, reason: 'ADMISSION_PROOF_REQUIRED' };
}

export function validateEventPublishability(
  event: AccessControlledEvent,
  inventory: { freeTicketTypes: number; paidTicketTypes: number } = { freeTicketTypes: 0, paidTicketTypes: 0 },
): PublishabilityResult {
  const errors = [...validateEventAccessConfiguration(event).errors];
  const warnings: string[] = [];
  if (event.accessModelVersion !== 2 && event.accessRules?.accessCode) {
    errors.push({ code: 'LEGACY_ACCESS_CODE_REQUIRES_MIGRATION', field: 'accessPolicy' });
  }
  if (!event.title?.trim()) errors.push({ code: 'TITLE_REQUIRED', field: 'title' });
  if (!event.eventType) errors.push({ code: 'EVENT_TYPE_REQUIRED', field: 'eventType' });
  if (!event.startDate) errors.push({ code: 'START_DATE_REQUIRED', field: 'startDate' });
  if (event.startDate && event.endDate && new Date(event.endDate) < new Date(event.startDate)) errors.push({ code: 'END_BEFORE_START', field: 'endDate' });
  if (event.location?.type === EventLocationType.PHYSICAL && !event.location.name && !event.location.address) errors.push({ code: 'PHYSICAL_LOCATION_REQUIRED', field: 'location' });
  if (event.location?.type === EventLocationType.ONLINE && !event.location.onlineUrl) warnings.push('ONLINE_URL_MISSING');
  if (event.admissionModes?.includes(AdmissionMode.FREE_TICKET) && inventory.freeTicketTypes === 0) errors.push({ code: 'FREE_TICKET_TYPE_REQUIRED', field: 'ticketTypes' });
  if (event.admissionModes?.includes(AdmissionMode.PAID_TICKET) && inventory.paidTicketTypes === 0) errors.push({ code: 'PAID_TICKET_TYPE_REQUIRED', field: 'ticketTypes' });
  const uniqueErrors = [...new Map(errors.map((error) => [`${error.code}:${error.field}`, error])).values()];
  return { publishable: uniqueErrors.length === 0, errors: uniqueErrors, warnings: [...new Set(warnings)] };
}
