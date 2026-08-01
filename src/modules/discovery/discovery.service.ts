import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event, EventDiscoverability, EventDocument, EventStatus, EventVisibility } from '../events/event.schema';
import { VendorProfile, VendorProfileDocument } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileDocument } from '../venues/venue.schema';

export interface SearchResults {
  events: Event[];
  vendors: VendorProfile[];
  venues: VenueProfile[];
}

const publicEventFilter = {
  status: EventStatus.PUBLISHED,
  $or: [
    { discoverability: EventDiscoverability.PUBLIC },
    { accessModelVersion: { $exists: false }, visibility: EventVisibility.PUBLIC },
  ],
};

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
        .find({ $and: [publicEventFilter, { $or: [{ title: regex }, { description: regex }, { 'location.city': regex }] }] })
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
      .find(publicEventFilter)
      .sort({ startDate: 1 })
      .limit(limit)
      .lean()
      .select('title startDate location coverImage slug');
  }

  async findEvents(q?: string, city?: string, page = 1, limit = 12): Promise<{ data: Event[]; total: number }> {
    const filter: Record<string, unknown> = {
      ...publicEventFilter,
    };
    if (q) {
      delete filter['$or'];
      filter['$and'] = [publicEventFilter, { $or: [{ title: { $regex: q, $options: 'i' } }, { description: { $regex: q, $options: 'i' } }] }];
    }
    if (city) filter['location.city'] = { $regex: city, $options: 'i' };
    const [data, total] = await Promise.all([
      this.eventModel.find(filter).sort({ startDate: 1 }).skip((page - 1) * limit).limit(limit).lean().select('title startDate location status slug coverImage'),
      this.eventModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  async findVendors(q?: string, category?: string, page = 1, limit = 12): Promise<{ data: VendorProfile[]; total: number }> {
    const filter: Record<string, unknown> = { isActive: true };
    if (q) filter['$or'] = [{ businessName: { $regex: q, $options: 'i' } }, { description: { $regex: q, $options: 'i' } }];
    if (category) filter['category'] = category;
    const [data, total] = await Promise.all([
      this.vendorModel.find(filter).skip((page - 1) * limit).limit(limit).lean().select('businessName category serviceArea rating reviewCount'),
      this.vendorModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  async findVenues(q?: string, city?: string, page = 1, limit = 12): Promise<{ data: VenueProfile[]; total: number }> {
    const filter: Record<string, unknown> = { isActive: true };
    if (q) filter['$or'] = [{ name: { $regex: q, $options: 'i' } }, { 'address.city': { $regex: q, $options: 'i' } }];
    if (city) filter['address.city'] = { $regex: city, $options: 'i' };
    const [data, total] = await Promise.all([
      this.venueModel.find(filter).skip((page - 1) * limit).limit(limit).lean().select('name address capacity rating reviewCount pricePerDay'),
      this.venueModel.countDocuments(filter),
    ]);
    return { data, total };
  }
}
