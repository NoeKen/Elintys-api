import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event, EventDocument, EventStatus, EventVisibility } from '../events/event.schema';
import { VendorProfile, VendorProfileDocument } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileDocument } from '../venues/venue.schema';

export interface SearchResults {
  events: Event[];
  vendors: VendorProfile[];
  venues: VenueProfile[];
}

@Injectable()
export class DiscoveryService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(VendorProfile.name) private readonly vendorModel: Model<VendorProfileDocument>,
    @InjectModel(VenueProfile.name) private readonly venueModel: Model<VenueProfileDocument>,
  ) {}

  async search(q: string, page = 1, limit = 10): Promise<SearchResults> {
    const regex = { $regex: q, $options: 'i' };
    const skip = (page - 1) * limit;

    const [events, vendors, venues] = await Promise.all([
      this.eventModel
        .find({
          status: EventStatus.PUBLISHED,
          visibility: EventVisibility.PUBLIC,
          $or: [{ title: regex }, { description: regex }, { 'location.city': regex }],
        })
        .skip(skip)
        .limit(limit)
        .lean()
        .select('title startDate location status slug'),
      this.vendorModel
        .find({ isActive: true, $or: [{ businessName: regex }, { description: regex }] })
        .skip(skip)
        .limit(limit)
        .lean()
        .select('businessName category serviceArea rating'),
      this.venueModel
        .find({ isActive: true, $or: [{ name: regex }, { 'address.city': regex }] })
        .skip(skip)
        .limit(limit)
        .lean()
        .select('name address capacity rating'),
    ]);

    return { events, vendors, venues };
  }

  async featuredEvents(limit = 6): Promise<Event[]> {
    return this.eventModel
      .find({ status: EventStatus.PUBLISHED, visibility: EventVisibility.PUBLIC })
      .sort({ startDate: 1 })
      .limit(limit)
      .lean()
      .select('title startDate location coverImage slug');
  }
}
