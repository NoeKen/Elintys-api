import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VenueManagersService } from './venue-managers.service';
import { UpsertVenueManagerDto } from './dto/upsert-venue-manager.dto';

const chain = (value: unknown) => ({ lean: () => ({ select: () => Promise.resolve(value) }) });

describe('VenueManagersService', () => {
  const user = new Types.ObjectId();
  it('returns 404 when the authenticated account has no manager profile', async () => {
    const service = new VenueManagersService({ findOne: () => chain(null) } as never);
    await expect(service.findMine(user.toHexString())).rejects.toThrow(NotFoundException);
  });
  it('upserts only explicitly allowed business fields under JWT identity', async () => {
    const findOneAndUpdate = jest.fn().mockReturnValue(chain({ user, professionalName: 'Gestion ABC' }));
    const service = new VenueManagersService({ findOneAndUpdate } as never);
    const result = await service.upsertMine(user.toHexString(), {
      professionalName: 'Gestion ABC', user: new Types.ObjectId(), rating: 5,
    } as never);
    expect(result.professionalName).toBe('Gestion ABC');
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { user },
      { $set: { professionalName: 'Gestion ABC' }, $setOnInsert: { user } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
  });
  it('rejects empty professional name and client-controlled ownership', async () => {
    const errors = await validate(plainToInstance(UpsertVenueManagerDto, { professionalName: ' ', user: 'forged' }), {
      whitelist: true, forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['professionalName', 'user']));
  });
  it('normalizes business contact fields', async () => {
    const dto = plainToInstance(UpsertVenueManagerDto, { professionalName: ' ABC ', contactEmail: ' HELLO@EXAMPLE.COM ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto).toMatchObject({ professionalName: 'ABC', contactEmail: 'hello@example.com' });
  });
});
