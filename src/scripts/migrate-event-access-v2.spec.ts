import { Types } from 'mongoose';
import {
  assertEventAccessMigrationAllowed,
  extractDatabaseName,
  planEventAccessMigration,
} from './migrate-event-access-v2';
import {
  AdmissionMode,
  EventAccessPolicyType,
  EventDiscoverability,
  EventVisibility,
} from '../modules/events/event.schema';
import {
  AccessControlledEvent,
  LegacyAccessShape,
  normalizeLegacyEventAccess,
  resolveLegacyAccessShape,
} from '../modules/events/event-access.policy';

describe('event access v2 migration plan', () => {
  const id = new Types.ObjectId();

  it('mappe public et invite_only de façon déterministe', () => {
    expect(planEventAccessMigration({ _id: id, visibility: EventVisibility.PUBLIC }).update)
      .toMatchObject({ discoverability: EventDiscoverability.PUBLIC, accessPolicy: { type: EventAccessPolicyType.OPEN } });
    expect(planEventAccessMigration({ _id: id, visibility: EventVisibility.INVITE_ONLY }).update)
      .toMatchObject({ discoverability: EventDiscoverability.UNLISTED, accessPolicy: { type: EventAccessPolicyType.INVITATION_TOKEN } });
  });

  it('signale les événements privés ambigus sans produire de mise à jour', () => {
    const plan = planEventAccessMigration({ _id: id, visibility: EventVisibility.PRIVATE });
    expect(plan.update).toBeUndefined();
    expect(plan.ambiguousReason).toBe('PRIVATE_INTENT_UNDETERMINED');
  });

  it('ne prétend pas migrer un code dont la valeur brute est absente', () => {
    const plan = planEventAccessMigration({
      _id: id,
      visibility: EventVisibility.PRIVATE,
      accessRules: { accessCode: true },
    });
    expect(plan.update).toBeUndefined();
    expect(plan.ambiguousReason).toBe('ACCESS_CODE_MISSING_RAW_VALUE');
  });
});

describe('mapping legacy → V2 : priorité restriction la plus forte (F-027)', () => {
  const id = new Types.ObjectId();

  it('devrait conserver private + manual_approval quand manualApproval ET allowedEmailDomain coexistent', () => {
    const event = {
      _id: id,
      visibility: EventVisibility.PRIVATE,
      accessRules: { manualApproval: true, allowedEmailDomain: 'elintys.ca' },
    };
    const plan = planEventAccessMigration(event);

    // Régression F-027 : ne doit JAMAIS devenir unlisted + email_domain.
    expect(plan.update).toBeDefined();
    expect(plan.update?.discoverability).toBe(EventDiscoverability.PRIVATE);
    expect(plan.update?.accessPolicy.type).toBe(EventAccessPolicyType.MANUAL_APPROVAL);
    expect(plan.update?.discoverability).not.toBe(EventDiscoverability.UNLISTED);
    expect(plan.update?.accessPolicy.type).not.toBe(EventAccessPolicyType.EMAIL_DOMAIN);
  });

  const legacyCases: Array<{
    label: string;
    event: { visibility?: EventVisibility; accessRules?: Record<string, unknown> };
    expected:
      | { status: 'mapped'; discoverability: EventDiscoverability; policy: EventAccessPolicyType }
      | { status: 'ambiguous'; reason: string };
  }> = [
    {
      label: 'public',
      event: { visibility: EventVisibility.PUBLIC },
      expected: { status: 'mapped', discoverability: EventDiscoverability.PUBLIC, policy: EventAccessPolicyType.OPEN },
    },
    {
      label: 'visibility absente',
      event: {},
      expected: { status: 'mapped', discoverability: EventDiscoverability.PUBLIC, policy: EventAccessPolicyType.OPEN },
    },
    {
      label: 'invite_only',
      event: { visibility: EventVisibility.INVITE_ONLY },
      expected: { status: 'mapped', discoverability: EventDiscoverability.UNLISTED, policy: EventAccessPolicyType.INVITATION_TOKEN },
    },
    {
      label: 'private seul',
      event: { visibility: EventVisibility.PRIVATE },
      expected: { status: 'ambiguous', reason: 'PRIVATE_INTENT_UNDETERMINED' },
    },
    {
      label: 'private + accessCode',
      event: { visibility: EventVisibility.PRIVATE, accessRules: { accessCode: true } },
      expected: { status: 'ambiguous', reason: 'ACCESS_CODE_MISSING_RAW_VALUE' },
    },
    {
      label: 'private + allowedEmailDomain',
      event: { visibility: EventVisibility.PRIVATE, accessRules: { allowedEmailDomain: '@Elintys.CA' } },
      expected: { status: 'mapped', discoverability: EventDiscoverability.UNLISTED, policy: EventAccessPolicyType.EMAIL_DOMAIN },
    },
    {
      label: 'private + manualApproval',
      event: { visibility: EventVisibility.PRIVATE, accessRules: { manualApproval: true } },
      expected: { status: 'mapped', discoverability: EventDiscoverability.PRIVATE, policy: EventAccessPolicyType.MANUAL_APPROVAL },
    },
    {
      label: 'private + accessCode + manualApproval',
      event: { visibility: EventVisibility.PRIVATE, accessRules: { accessCode: true, manualApproval: true } },
      expected: { status: 'ambiguous', reason: 'ACCESS_CODE_MISSING_RAW_VALUE' },
    },
    {
      label: 'private + allowedEmailDomain + manualApproval',
      event: { visibility: EventVisibility.PRIVATE, accessRules: { manualApproval: true, allowedEmailDomain: 'elintys.ca' } },
      expected: { status: 'mapped', discoverability: EventDiscoverability.PRIVATE, policy: EventAccessPolicyType.MANUAL_APPROVAL },
    },
    {
      label: 'private + accessCode + allowedEmailDomain',
      event: { visibility: EventVisibility.PRIVATE, accessRules: { accessCode: true, allowedEmailDomain: 'elintys.ca' } },
      expected: { status: 'ambiguous', reason: 'ACCESS_CODE_MISSING_RAW_VALUE' },
    },
    {
      label: 'private + accessRules vide',
      event: { visibility: EventVisibility.PRIVATE, accessRules: {} },
      expected: { status: 'ambiguous', reason: 'PRIVATE_INTENT_UNDETERMINED' },
    },
  ];

  it.each(legacyCases)('devrait mapper « $label » comme attendu', ({ event, expected }) => {
    const plan = planEventAccessMigration({ _id: id, ...event } as never);
    if (expected.status === 'ambiguous') {
      expect(plan.update).toBeUndefined();
      expect(plan.ambiguousReason).toBe(expected.reason);
      return;
    }
    expect(plan.ambiguousReason).toBeUndefined();
    expect(plan.update?.discoverability).toBe(expected.discoverability);
    expect(plan.update?.accessPolicy.type).toBe(expected.policy);
    expect(plan.update?.accessModelVersion).toBe(2);
    expect(plan.update?.admissionModes.length).toBeGreaterThan(0);
  });

  it.each(legacyCases)(
    'devrait produire un résultat effectif IDENTIQUE entre migration et runtime — « $label »',
    ({ event }) => {
      const source = event as AccessControlledEvent;
      const plan = planEventAccessMigration({ _id: id, ...event } as never);
      const runtime = normalizeLegacyEventAccess({ ...source });
      // Forme effective côté migration : la mise à jour si mappée, sinon le repli runtime.
      const effective: LegacyAccessShape = plan.update ?? resolveLegacyAccessShape(source);

      expect(effective.discoverability).toBe(runtime.discoverability);
      expect(effective.accessPolicy).toEqual(runtime.accessPolicy);
      expect(effective.admissionModes).toEqual(runtime.admissionModes);
    },
  );

  it('devrait normaliser le domaine autorisé de la même façon des deux côtés', () => {
    const event: AccessControlledEvent = {
      visibility: EventVisibility.PRIVATE,
      accessRules: { allowedEmailDomain: '  @Elintys.CA ' },
    };
    const plan = planEventAccessMigration({ _id: id, ...event } as never);
    expect(plan.update?.accessPolicy.allowedDomains).toEqual(['elintys.ca']);
    expect(normalizeLegacyEventAccess({ ...event }).accessPolicy.allowedDomains).toEqual(['elintys.ca']);
  });

  it('ne devrait pas retoucher un événement déjà en V2', () => {
    const alreadyV2: AccessControlledEvent = {
      discoverability: EventDiscoverability.PRIVATE,
      accessPolicy: { type: EventAccessPolicyType.GUEST_LIST },
      admissionModes: [AdmissionMode.REGISTRATION_ONLY],
    };
    expect(normalizeLegacyEventAccess({ ...alreadyV2 })).toMatchObject(alreadyV2);
  });
});

describe('garde d’environnement de la migration (F-029)', () => {
  const devUri = 'mongodb+srv://user:pass@example.mongodb.net/elintys-dev?retryWrites=true';

  it('devrait autoriser dev + elintys-dev', () => {
    expect(() => assertEventAccessMigrationAllowed('dev', devUri)).not.toThrow();
  });

  it('devrait refuser la base de production elintys', () => {
    expect(() =>
      assertEventAccessMigrationAllowed('dev', 'mongodb+srv://u:p@example.mongodb.net/elintys'),
    ).toThrow(/MIGRATION_REFUSED/);
  });

  it('devrait refuser un environnement prod même sur elintys-dev', () => {
    expect(() => assertEventAccessMigrationAllowed('prod', devUri)).toThrow(
      /ELINTYS_ENV must be exactly "dev"/,
    );
  });

  it('devrait refuser une URI absente', () => {
    expect(() => assertEventAccessMigrationAllowed('dev', undefined)).toThrow(
      /MONGODB_URI is required/,
    );
  });

  it('devrait refuser une URI sans nom de base explicite', () => {
    expect(() =>
      assertEventAccessMigrationAllowed('dev', 'mongodb+srv://u:p@example.mongodb.net/'),
    ).toThrow(/explicit database/);
    expect(() =>
      assertEventAccessMigrationAllowed('dev', 'mongodb+srv://u:p@example.mongodb.net'),
    ).toThrow(/explicit database/);
  });

  it('devrait refuser une URI invalide', () => {
    expect(() => assertEventAccessMigrationAllowed('dev', 'pas-une-uri')).toThrow(
      /explicit database/,
    );
  });

  it('devrait refuser toute base inconnue', () => {
    expect(() =>
      assertEventAccessMigrationAllowed('dev', 'mongodb+srv://u:p@example.mongodb.net/autre-base'),
    ).toThrow(/must be exactly "elintys-dev"/);
  });

  it('devrait extraire le nom de base correctement', () => {
    expect(extractDatabaseName(devUri)).toBe('elintys-dev');
    expect(extractDatabaseName('mongodb+srv://u:p@h.net/')).toBeUndefined();
    expect(extractDatabaseName('invalide')).toBeUndefined();
  });
});
