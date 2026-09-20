import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { isDuplicateKeyError } from '../../shared/utils/mongo-errors';
import { UpsertVenueManagerDto } from './dto/upsert-venue-manager.dto';
import { VenueManagerProfile, VenueManagerProfileDocument } from './venue-manager.schema';

@Injectable()
export class VenueManagersService {
  constructor(@InjectModel(VenueManagerProfile.name) private readonly model: Model<VenueManagerProfileDocument>) {}

  async findMine(userId: string) {
    const profile = await this.model.findOne({ user: new Types.ObjectId(userId) }).lean().select('-__v');
    if (!profile) throw new NotFoundException(ErrorCodes.VENUE_MANAGER_PROFILE_NOT_FOUND);
    return profile;
  }

  async ownerOf(profileId: Types.ObjectId): Promise<string> {
    if (!profileId) throw new NotFoundException(ErrorCodes.VENUE_MANAGER_PROFILE_NOT_FOUND);
    const profile = await this.model.findById(profileId).lean().select('user');
    if (!profile) throw new NotFoundException(ErrorCodes.VENUE_MANAGER_PROFILE_NOT_FOUND);
    return profile.user.toString();
  }

  async upsertMine(userId: string, dto: UpsertVenueManagerDto) {
    const user = new Types.ObjectId(userId);
    const fields: Record<string, unknown> = { professionalName: dto.professionalName };
    for (const key of ['description', 'region', 'contactEmail', 'contactPhone'] as const) {
      if (dto[key] !== undefined) fields[key] = dto[key];
    }
    const update = { $set: fields, $setOnInsert: { user } };
    try {
      return await this.model.findOneAndUpdate({ user }, update, {
        upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true,
      }).lean().select('-__v');
    } catch (error) {
      // Concurrent first PUT: the unique user index elects one creator.
      if (!isDuplicateKeyError(error)) throw error;
      const result = await this.model.findOneAndUpdate({ user }, { $set: fields }, {
        new: true, runValidators: true,
      }).lean().select('-__v');
      if (!result) throw error;
      return result;
    }
  }
}
