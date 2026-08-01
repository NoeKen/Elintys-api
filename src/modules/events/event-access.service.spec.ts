import { BadRequestException } from '@nestjs/common';
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
