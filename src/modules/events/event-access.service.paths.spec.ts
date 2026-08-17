import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { EventAccessService } from './event-access.service';
import {
  EventAccessPolicyType,
  EventDiscoverability,
  EventStatus,
  AdmissionMode,
} from './event.schema';
import { EventAccessRequestStatus } from './event-access-request.schema';

/**
 * Couverture des chemins critiques d'Access V2 (finding F-013) :
 * politiques, ownership, code d'accès, domaine, grants, demandes d'accès.
 */

const SECRET = 'test-secret-with-at-least-32-characters';

/** Chaîne de query Mongoose mockée : .lean().select() → valeur. */
function leanSelect(value: unknown) {
  return { lean: () => ({ select: jest.fn().mockResolvedValue(value) }) };
}
/** Chaîne .select().exec() → valeur. */
function selectExec(value: unknown) {
  return { select: () => ({ exec: jest.fn().mockResolvedValue(value) }) };
}

interface Models {
  eventModel?: unknown;
  requestModel?: unknown;
  userModel?: unknown;
  guestModel?: unknown;
  invitationModel?: unknown;
}

function makeService(models: Models = {}): EventAccessService {
  return new EventAccessService(
    (models.eventModel ?? {}) as never,
    (models.requestModel ?? {}) as never,
    (models.userModel ?? {}) as never,
    (models.guestModel ?? {}) as never,
    (models.invitationModel ?? {}) as never,
    new JwtService(),
    { getOrThrow: jest.fn().mockReturnValue(SECRET) } as never,
  );
}

describe('EventAccessService — preparePolicy', () => {
  it('devrait normaliser les domaines autorisés (casse, espaces, arobase)', async () => {
    const policy = await makeService().preparePolicy({
      type: EventAccessPolicyType.EMAIL_DOMAIN,
      requiresAuthentication: true,
      allowedDomains: ['  @Elintys.CA ', 'EXEMPLE.COM'],
    });
    expect(policy.allowedDomains).toEqual(['elintys.ca', 'exemple.com']);
  });

  it('devrait conserver le hash existant si aucun nouveau code n’est fourni', async () => {
    const existing = await bcrypt.hash('ancien-code', 4);
    const policy = await makeService().preparePolicy(
      { type: EventAccessPolicyType.ACCESS_CODE },
      existing,
    );
    expect(policy.codeHash).toBe(existing);
  });

  it('ne devrait produire aucun hash pour une politique sans code', async () => {
    const policy = await makeService().preparePolicy({ type: EventAccessPolicyType.OPEN });
    expect(policy.codeHash).toBeUndefined();
  });

  it.each([
    [EventAccessPolicyType.OPEN, { code: 'x' }],
    [EventAccessPolicyType.INVITATION_TOKEN, { allowedDomains: ['a.ca'] }],
    [EventAccessPolicyType.MANUAL_APPROVAL, { code: 'x' }],
  ])('devrait rejeter les champs étrangers à la politique %s', async (type, extra) => {
    await expect(
      makeService().preparePolicy({ type, ...extra } as never),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('EventAccessService — updateConfiguration (ownership)', () => {
  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();

  function eventDoc(overrides: Record<string, unknown> = {}) {
    const doc = {
      organizer: { toString: () => organizerId },
      accessPolicy: { codeHash: 'hash-existant' },
      discoverability: EventDiscoverability.PUBLIC,
      admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      accessModelVersion: 1,
      status: EventStatus.DRAFT,
      save: jest.fn().mockResolvedValue(undefined),
      toObject() {
        return { ...this };
      },
      ...overrides,
    };
    return doc;
  }

  it('devrait refuser si l’événement est introuvable', async () => {
    const service = makeService({ eventModel: { findById: () => selectExec(null) } });
    await expect(
      service.updateConfiguration(eventId, { userId: organizerId }, {
        discoverability: EventDiscoverability.PUBLIC,
        accessPolicy: { type: EventAccessPolicyType.OPEN },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser un utilisateur tiers (ownership)', async () => {
    const service = makeService({ eventModel: { findById: () => selectExec(eventDoc()) } });
    await expect(
      service.updateConfiguration(eventId, { userId: new Types.ObjectId().toString() }, {
        discoverability: EventDiscoverability.PUBLIC,
        accessPolicy: { type: EventAccessPolicyType.OPEN },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('devrait rejeter une configuration invalide (private + open)', async () => {
    const service = makeService({ eventModel: { findById: () => selectExec(eventDoc()) } });
    await expect(
      service.updateConfiguration(eventId, { userId: organizerId }, {
        discoverability: EventDiscoverability.PRIVATE,
        accessPolicy: { type: EventAccessPolicyType.OPEN },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('devrait persister la configuration et marquer accessModelVersion=2', async () => {
    const doc = eventDoc();
    const service = makeService({ eventModel: { findById: () => selectExec(doc) } });
    const result = await service.updateConfiguration(eventId, { userId: organizerId }, {
      discoverability: EventDiscoverability.UNLISTED,
      accessPolicy: { type: EventAccessPolicyType.INVITATION_TOKEN },
      admissionModes: [AdmissionMode.INVITATION],
    });
    expect(doc.save).toHaveBeenCalled();
    expect(doc.accessModelVersion).toBe(2);
    expect(doc.discoverability).toBe(EventDiscoverability.UNLISTED);
    expect(result.accessPolicy).not.toHaveProperty('codeHash');
  });
});

describe('EventAccessService — verifyCode', () => {
  const eventId = new Types.ObjectId().toString();

  it('devrait refuser si l’événement publié est introuvable', async () => {
    const service = makeService({ eventModel: { findOne: () => selectExec(null) } });
    await expect(service.verifyCode(eventId, 'peu-importe')).rejects.toThrow(ForbiddenException);
  });

  it('devrait refuser si la politique n’est pas access_code', async () => {
    const service = makeService({
      eventModel: {
        findOne: () => selectExec({ accessPolicy: { type: EventAccessPolicyType.OPEN } }),
      },
    });
    await expect(service.verifyCode(eventId, 'code')).rejects.toThrow(ForbiddenException);
  });

  it('devrait refuser un code erroné', async () => {
    const codeHash = await bcrypt.hash('bon-code', 4);
    const service = makeService({
      eventModel: {
        findOne: () =>
          selectExec({ accessPolicy: { type: EventAccessPolicyType.ACCESS_CODE, codeHash } }),
      },
    });
    await expect(service.verifyCode(eventId, 'mauvais-code')).rejects.toThrow(ForbiddenException);
  });

  it('devrait émettre un grant signé pour un code valide', async () => {
    const codeHash = await bcrypt.hash('bon-code', 4);
    const service = makeService({
      eventModel: {
        findOne: () =>
          selectExec({ accessPolicy: { type: EventAccessPolicyType.ACCESS_CODE, codeHash } }),
      },
    });
    const result = await service.verifyCode(eventId, 'bon-code');
    expect(result.authorized).toBe(true);
    expect(typeof result.accessGrant).toBe('string');
    expect(result.accessGrant.split('.')).toHaveLength(3);
  });

  it('limite la vérification aux événements publiés non archivés', async () => {
    const findOne = jest.fn().mockReturnValue(selectExec(null));
    const service = makeService({ eventModel: { findOne } });

    await expect(service.verifyCode(eventId, 'code')).rejects.toThrow(ForbiddenException);
    expect(findOne).toHaveBeenCalledWith({
      _id: eventId,
      status: EventStatus.PUBLISHED,
      archivedAt: null,
    });
  });
});

describe('EventAccessService — resolveAccessGrant', () => {
  const eventId = new Types.ObjectId().toString();

  async function grantFor(id: string): Promise<string> {
    return new JwtService().signAsync(
      { sub: 'event-access', eventId: id, purpose: 'event-access' },
      { secret: SECRET, expiresIn: '15m', audience: 'elintys-event-access' },
    );
  }

  it('devrait refuser un jeton invalide', async () => {
    await expect(makeService().resolveAccessGrant('pas-un-jeton')).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser un jeton dont l’audience diffère', async () => {
    const token = await new JwtService().signAsync(
      { sub: 'x', eventId, purpose: 'event-access' },
      { secret: SECRET, audience: 'autre-audience' },
    );
    await expect(makeService().resolveAccessGrant(token)).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser un jeton dont le purpose diffère', async () => {
    const token = await new JwtService().signAsync(
      { sub: 'x', eventId, purpose: 'autre' },
      { secret: SECRET, audience: 'elintys-event-access' },
    );
    await expect(makeService().resolveAccessGrant(token)).rejects.toThrow(NotFoundException);
  });

  it('devrait remonter EVENT_NOT_FOUND si l’événement du grant n’existe plus', async () => {
    const service = makeService({ eventModel: { findOne: () => leanSelect(null) } });
    await expect(service.resolveAccessGrant(await grantFor(eventId))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('devrait retourner la projection publique pour un grant valide', async () => {
    const service = makeService({
      eventModel: {
        findOne: () =>
          leanSelect({
            _id: eventId,
            title: 'Événement',
            organizer: 'org',
            accessPolicy: { type: EventAccessPolicyType.ACCESS_CODE },
          }),
      },
    });
    const event = await service.resolveAccessGrant(await grantFor(eventId));
    expect(event).not.toHaveProperty('organizer');
    expect(event.accessPolicy).toEqual({
      type: EventAccessPolicyType.ACCESS_CODE,
      hasAccessCode: true,
    });
  });

  it('résout le grant uniquement contre un événement actif', async () => {
    const findOne = jest.fn().mockReturnValue(leanSelect(null));
    const service = makeService({ eventModel: { findOne } });

    await expect(service.resolveAccessGrant(await grantFor(eventId))).rejects.toThrow(NotFoundException);
    expect(findOne).toHaveBeenCalledWith({
      _id: eventId,
      status: EventStatus.PUBLISHED,
      archivedAt: null,
    });
  });
});

describe('EventAccessService — checkDomain', () => {
  const eventId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  function service(event: unknown, user: unknown) {
    return makeService({
      eventModel: { findById: () => leanSelect(event) },
      userModel: { findById: () => leanSelect(user) },
    });
  }

  it('devrait refuser si l’événement n’est pas publié', async () => {
    await expect(
      service({ status: EventStatus.DRAFT }, { email: 'a@b.ca' }).checkDomain(eventId, userId),
    ).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser un événement archivé', async () => {
    await expect(
      service({
        status: EventStatus.PUBLISHED,
        archivedAt: new Date(),
        accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['elintys.ca'] },
      }, { email: 'marie@elintys.ca', isEmailVerified: true }).checkDomain(eventId, userId),
    ).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser si la politique domaine n’est pas active', async () => {
    await expect(
      service(
        { status: EventStatus.PUBLISHED, accessPolicy: { type: EventAccessPolicyType.OPEN } },
        { email: 'a@b.ca' },
      ).checkDomain(eventId, userId),
    ).rejects.toThrow(BadRequestException);
  });

  it('devrait exiger un courriel vérifié', async () => {
    const result = await service(
      {
        status: EventStatus.PUBLISHED,
        accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['elintys.ca'] },
      },
      { email: 'marie@elintys.ca', isEmailVerified: false },
    ).checkDomain(eventId, userId);
    expect(result).toEqual({ authorized: false, reason: 'VERIFIED_EMAIL_REQUIRED' });
  });

  it('devrait autoriser un domaine listé', async () => {
    const result = await service(
      {
        status: EventStatus.PUBLISHED,
        accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['elintys.ca'] },
      },
      { email: 'marie@elintys.ca', isEmailVerified: true },
    ).checkDomain(eventId, userId);
    expect(result).toEqual({ authorized: true, reason: 'EMAIL_DOMAIN_ALLOWED' });
  });

  it('devrait refuser un domaine non listé', async () => {
    const result = await service(
      {
        status: EventStatus.PUBLISHED,
        accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['elintys.ca'] },
      },
      { email: 'marie@ailleurs.com', isEmailVerified: true },
    ).checkDomain(eventId, userId);
    expect(result).toEqual({ authorized: false, reason: 'EMAIL_DOMAIN_NOT_ALLOWED' });
  });
});

describe('EventAccessService — requestAccess', () => {
  const eventId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  it('devrait refuser si l’événement n’est pas publié', async () => {
    const service = makeService({ eventModel: { findById: () => leanSelect(null) } });
    await expect(service.requestAccess(eventId, userId)).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser une demande sur un événement archivé', async () => {
    const service = makeService({
      eventModel: {
        findById: () => leanSelect({
          status: EventStatus.PUBLISHED,
          archivedAt: new Date(),
          accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
        }),
      },
    });

    await expect(service.requestAccess(eventId, userId)).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser si l’approbation manuelle n’est pas active', async () => {
    const service = makeService({
      eventModel: {
        findById: () =>
          leanSelect({ status: EventStatus.PUBLISHED, accessPolicy: { type: EventAccessPolicyType.OPEN } }),
      },
    });
    await expect(service.requestAccess(eventId, userId)).rejects.toThrow(BadRequestException);
  });

  it('devrait créer la demande d’accès', async () => {
    const created = { _id: new Types.ObjectId(), toObject: () => ({ status: 'pending' }) };
    const service = makeService({
      eventModel: {
        findById: () =>
          leanSelect({
            status: EventStatus.PUBLISHED,
            accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
          }),
      },
      requestModel: { create: jest.fn().mockResolvedValue(created) },
    });
    await expect(service.requestAccess(eventId, userId)).resolves.toEqual({ status: 'pending' });
  });

  it('devrait signaler une demande déjà existante (E11000)', async () => {
    const service = makeService({
      eventModel: {
        findById: () =>
          leanSelect({
            status: EventStatus.PUBLISHED,
            accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
          }),
      },
      requestModel: { create: jest.fn().mockRejectedValue({ code: 11000 }) },
    });
    await expect(service.requestAccess(eventId, userId)).rejects.toThrow(ConflictException);
  });
});

describe('EventAccessService — reviewRequest (ownership)', () => {
  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const requestId = new Types.ObjectId().toString();

  function makeReviewService(event: unknown, updated: unknown) {
    return makeService({
      eventModel: { findById: () => leanSelect(event) },
      requestModel: {
        findOneAndUpdate: () => ({
          lean: () => ({ select: jest.fn().mockResolvedValue(updated) }),
        }),
      },
    });
  }

  it('devrait refuser si l’événement est introuvable', async () => {
    await expect(
      makeReviewService(null, null).reviewRequest(eventId, requestId, { userId: organizerId }, EventAccessRequestStatus.APPROVED),
    ).rejects.toThrow(NotFoundException);
  });

  it('devrait refuser un tiers non propriétaire', async () => {
    await expect(
      makeReviewService({ organizer: { toString: () => organizerId } }, null).reviewRequest(
        eventId,
        requestId,
        { userId: new Types.ObjectId().toString() },
        EventAccessRequestStatus.APPROVED,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('devrait refuser si la demande est introuvable', async () => {
    await expect(
      makeReviewService({ organizer: { toString: () => organizerId } }, null).reviewRequest(
        eventId,
        requestId,
        { userId: organizerId },
        EventAccessRequestStatus.APPROVED,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('devrait approuver une demande pour le propriétaire', async () => {
    const updated = { status: EventAccessRequestStatus.APPROVED };
    await expect(
      makeReviewService({ organizer: { toString: () => organizerId } }, updated).reviewRequest(
        eventId,
        requestId,
        { userId: organizerId },
        EventAccessRequestStatus.APPROVED,
      ),
    ).resolves.toEqual(updated);
  });
});

describe('EventAccessService — buildActor', () => {
  const eventId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  function makeActorService(opts: {
    user?: unknown;
    request?: unknown;
    guest?: unknown;
    invitation?: unknown;
  }) {
    return makeService({
      userModel: { findById: () => leanSelect(opts.user ?? null) },
      requestModel: { findOne: () => leanSelect(opts.request ?? null) },
      guestModel: { findOne: () => leanSelect(opts.guest ?? null) },
      invitationModel: { findOne: () => leanSelect(opts.invitation ?? null) },
    });
  }

  it('devrait refléter l’absence de tout droit', async () => {
    const actor = await makeActorService({
      user: { email: 'a@b.ca', isEmailVerified: true, roles: ['organisateur'] },
    }).buildActor(userId, eventId);
    expect(actor).toMatchObject({
      hasApprovedRequest: false,
      isOnGuestList: false,
      hasInvitation: false,
      accessGrant: false,
    });
  });

  it('devrait détecter demande approuvée, liste d’invités et invitation acceptée', async () => {
    const actor = await makeActorService({
      user: { email: 'a@b.ca', isEmailVerified: true, roles: [] },
      request: { _id: 'r' },
      guest: { _id: 'g' },
      invitation: { _id: 'i' },
    }).buildActor(userId, eventId);
    expect(actor).toMatchObject({
      hasApprovedRequest: true,
      isOnGuestList: true,
      hasInvitation: true,
    });
  });

  it('devrait ignorer un grant invalide sans lever', async () => {
    const actor = await makeActorService({
      user: { email: 'a@b.ca', isEmailVerified: true, roles: [] },
    }).buildActor(userId, eventId, 'grant-invalide');
    expect(actor.accessGrant).toBe(false);
  });

  it('devrait fonctionner sans utilisateur trouvé', async () => {
    const actor = await makeActorService({ user: null }).buildActor(userId, eventId);
    expect(actor.email).toBeUndefined();
    expect(actor.isOnGuestList).toBe(false);
  });
});

describe('EventAccessService — assertRegistrationAllowed', () => {
  it('devrait laisser passer un événement public ouvert', () => {
    expect(() =>
      makeService().assertRegistrationAllowed({ userId: 'u1' }, {
        status: EventStatus.PUBLISHED,
        discoverability: EventDiscoverability.PUBLIC,
        accessPolicy: { type: EventAccessPolicyType.OPEN },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      } as never),
    ).not.toThrow();
  });

  it('devrait refuser un événement privé sans droit', () => {
    expect(() =>
      makeService().assertRegistrationAllowed({ userId: 'u1' }, {
        status: EventStatus.PUBLISHED,
        discoverability: EventDiscoverability.PRIVATE,
        accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      } as never),
    ).toThrow(ForbiddenException);
  });
});

describe('EventAccessService — findAuthorizedEvent', () => {
  const eventId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  function makeFindService(event: unknown) {
    return makeService({
      eventModel: { findOne: () => leanSelect(event) },
      userModel: { findById: () => leanSelect({ email: 'a@b.ca', isEmailVerified: true, roles: [] }) },
      requestModel: { findOne: () => leanSelect(null) },
      guestModel: { findOne: () => leanSelect(null) },
      invitationModel: { findOne: () => leanSelect(null) },
    });
  }

  it('devrait remonter EVENT_NOT_FOUND si absent', async () => {
    await expect(makeFindService(null).findAuthorizedEvent(eventId, userId)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('devrait masquer un événement privé en EVENT_NOT_FOUND (pas de fuite)', async () => {
    await expect(
      makeFindService({
        _id: eventId,
        status: EventStatus.PUBLISHED,
        organizer: new Types.ObjectId(),
        discoverability: EventDiscoverability.PRIVATE,
        accessPolicy: { type: EventAccessPolicyType.MANUAL_APPROVAL },
        admissionModes: [AdmissionMode.REGISTRATION_ONLY],
      }).findAuthorizedEvent(eventId, userId),
    ).rejects.toThrow(NotFoundException);
  });

  it('devrait retourner la projection publique d’un événement public', async () => {
    const event = await makeFindService({
      _id: eventId,
      title: 'Public',
      status: EventStatus.PUBLISHED,
      organizer: new Types.ObjectId(),
      discoverability: EventDiscoverability.PUBLIC,
      accessPolicy: { type: EventAccessPolicyType.OPEN },
      admissionModes: [AdmissionMode.REGISTRATION_ONLY],
    }).findAuthorizedEvent(eventId, userId);
    expect(event).not.toHaveProperty('organizer');
    expect(event).toMatchObject({ title: 'Public' });
  });

  it('devrait normaliser un événement legacy (sans champs V2)', async () => {
    const event = await makeFindService({
      _id: eventId,
      title: 'Legacy',
      status: EventStatus.PUBLISHED,
      organizer: new Types.ObjectId(),
      visibility: 'public',
    }).findAuthorizedEvent(eventId, userId);
    expect(event).toMatchObject({ title: 'Legacy' });
    expect(event).not.toHaveProperty('visibility');
  });
});
