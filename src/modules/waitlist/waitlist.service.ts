import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WaitlistEntry, WaitlistEntryDocument } from './waitlist.schema';
import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';

@Injectable()
export class WaitlistService {
  constructor(
    @InjectModel(WaitlistEntry.name) private readonly waitlistModel: Model<WaitlistEntryDocument>,
  ) {}

  async join(dto: CreateWaitlistEntryDto): Promise<{ alreadyExists: boolean }> {
    const existing = await this.waitlistModel.findOne({ email: dto.email }).lean().select('_id');
    if (existing) {
      return { alreadyExists: true };
    }

    await this.waitlistModel.create({
      firstName: dto.firstName,
      email: dto.email,
      role: dto.role,
      source: dto.source,
      consentMarketing: dto.consentMarketing ?? false,
    });

    return { alreadyExists: false };
  }

  async count(): Promise<number> {
    return this.waitlistModel.estimatedDocumentCount();
  }
}
