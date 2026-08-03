import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { EventAccessService } from './event-access.service';
import { EventAccessPolicyType } from './event.schema';

describe('EventAccessService security boundaries', () => {
  const service = new EventAccessService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new JwtService(),
    { getOrThrow: jest.fn().mockReturnValue('test-secret-with-at-least-32-characters') } as never,
  );

  it('hash le code brut et ne le conserve pas dans la policy', async () => {
    const policy = await service.preparePolicy({
      type: EventAccessPolicyType.ACCESS_CODE,
      code: 'Code-Securise-2026',
    });
    expect(policy).not.toHaveProperty('code');
    expect(policy.codeHash).not.toBe('Code-Securise-2026');
    await expect(bcrypt.compare('Code-Securise-2026', policy.codeHash!)).resolves.toBe(true);
  });

  it('rejette les champs étrangers au discriminant', async () => {
    await expect(service.preparePolicy({
      type: EventAccessPolicyType.OPEN,
      allowedDomains: ['entreprise.ca'],
    })).rejects.toThrow(BadRequestException);
  });

  it('retire le hash de la projection et expose seulement hasAccessCode', () => {
    const result = service.toSafeEvent({
      _id: 'event-1',
      accessPolicy: {
        type: EventAccessPolicyType.ACCESS_CODE,
        codeHash: 'secret-hash',
      },
    });
    expect(result.accessPolicy).not.toHaveProperty('codeHash');
    expect(result.accessPolicy).toMatchObject({ hasAccessCode: true });
  });

  it('retire les champs internes et les domaines de la projection publique', () => {
    const result = service.toPublicEvent({
      _id: 'event-1',
      organizer: 'user-1',
      creationProgress: { currentStep: 6 },
      accessPolicy: { type: EventAccessPolicyType.EMAIL_DOMAIN, allowedDomains: ['entreprise.ca'] },
    });
    expect(result).not.toHaveProperty('organizer');
    expect(result).not.toHaveProperty('creationProgress');
    expect(result.accessPolicy).toEqual({ type: EventAccessPolicyType.EMAIL_DOMAIN });
  });
});

describe('EventAccessService organizer request projection', () => {
  it('retourne uniquement le nom et le courriel du demandeur au propriétaire', async () => {
    const organizerId = new Types.ObjectId().toString();
    const eventId = new Types.ObjectId().toString();
    const query: Record<string, jest.Mock> = {};
    const expected = [{
      _id: new Types.ObjectId(),
      eventId: new Types.ObjectId(eventId),
      userId: { _id: new Types.ObjectId(), fullName: 'Marie Tremblay', email: 'marie@example.ca' },
      status: 'pending',
      requestedAt: new Date(),
    }];
    ['populate', 'sort', 'lean', 'select'].forEach((method) => {
      query[method] = jest.fn().mockReturnValue(query);
    });
    query.then = jest.fn((resolve: (value: unknown) => unknown) => Promise.resolve(expected).then(resolve));
    const eventModel = {
      findById: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({ organizer: { toString: () => organizerId } }),
        }),
      }),
    };
    const requestModel = { find: jest.fn().mockReturnValue(query) };
    const projectionService = new EventAccessService(
      eventModel as never,
      requestModel as never,
      {} as never,
      {} as never,
      {} as never,
      new JwtService(),
      { getOrThrow: jest.fn().mockReturnValue('test-secret-with-at-least-32-characters') } as never,
    );

    await expect(projectionService.listRequests(eventId, { userId: organizerId, roles: ['organisateur'] })).resolves.toEqual(expected);
    expect(query.populate).toHaveBeenCalledWith('userId', 'fullName email');
    expect(query.sort).toHaveBeenCalledWith({ requestedAt: -1 });
  });
});
