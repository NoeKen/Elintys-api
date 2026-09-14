import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event, EventDiscoverability, EventDocument, EventStatus, EventVisibility } from '../events/event.schema';
import { VendorProfile, VendorProfileDocument } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileDocument } from '../venues/venue.schema';
import { escapeRegExp } from '../../shared/utils/escape-regexp';
import { DiscoveryEntityType } from './dto/query-discovery.dto';
import { EventType } from '../events/event.schema';
import { VendorCategory } from '../vendors/vendor.schema';
import { VenueType } from '../venues/venue.schema';
import { VendorPriceTier } from '../vendors/dto/query-vendor.dto';

export interface SearchResults {
  events: Event[];
  vendors: VendorProfile[];
  venues: VenueProfile[];
  totals: { events: number; vendors: number; venues: number };
  page: number;
  limit: number;
}

const PUBLIC_EVENT_SEARCH_FIELDS =
  '_id title slug shortDescription eventType coverImage startDate endDate location status admissionModes';
const PUBLIC_VENDOR_SEARCH_FIELDS =
  '_id businessName category description photos priceRange serviceArea rating reviewCount isActive isPremium';
const PUBLIC_VENUE_SEARCH_FIELDS =
  '_id name type description address capacity photos amenities pricePerDay rating reviewCount isActive';

const publicEventFilter = {
  status: EventStatus.PUBLISHED,
  archivedAt: null,
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

  async search(
    q: string,
    page = 1,
    limit = 10,
    type: DiscoveryEntityType = DiscoveryEntityType.ALL,
  ): Promise<SearchResults> {
    // `escapeRegExp` : le terme vient d'une route PUBLIQUE et anonyme. Sans
    // échappement, `(a+)+$` provoque un retour arrière catastrophique — un
    // déni de service à coût nul pour l'appelant — et les métacaractères
    // laissent l'utilisateur réécrire le filtre.
    const regex = { $regex: escapeRegExp(q), $options: 'i' };
    const skip = (page - 1) * limit;

    const eventFilter = { $and: [publicEventFilter, { $or: [{ title: regex }, { shortDescription: regex }, { description: regex }, { 'location.city': regex }] }] };
    const vendorFilter = { isActive: true, $or: [{ businessName: regex }, { description: regex }, { serviceArea: regex }] };
    const venueFilter = { isActive: true, $or: [{ name: regex }, { description: regex }, { 'address.city': regex }] };
    const includeEvents = type === DiscoveryEntityType.ALL || type === DiscoveryEntityType.EVENT;
    const includeVendors = type === DiscoveryEntityType.ALL || type === DiscoveryEntityType.VENDOR;
    const includeVenues = type === DiscoveryEntityType.ALL || type === DiscoveryEntityType.VENUE;

    const [events, vendors, venues, eventTotal, vendorTotal, venueTotal] = await Promise.all([
      includeEvents ? this.eventModel
        .find(eventFilter)
        .sort({ startDate: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .select(PUBLIC_EVENT_SEARCH_FIELDS) : Promise.resolve([]),
      includeVendors ? this.vendorModel
        .find(vendorFilter)
        .sort({ rating: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .select(PUBLIC_VENDOR_SEARCH_FIELDS) : Promise.resolve([]),
      includeVenues ? this.venueModel
        .find(venueFilter)
        .sort({ rating: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .select(PUBLIC_VENUE_SEARCH_FIELDS) : Promise.resolve([]),
      includeEvents ? this.eventModel.countDocuments(eventFilter) : Promise.resolve(0),
      includeVendors ? this.vendorModel.countDocuments(vendorFilter) : Promise.resolve(0),
      includeVenues ? this.venueModel.countDocuments(venueFilter) : Promise.resolve(0),
    ]);

    return {
      events,
      vendors,
      venues,
      totals: { events: eventTotal, vendors: vendorTotal, venues: venueTotal },
      page,
      limit,
    };
  }

  async featuredEvents(limit = 6): Promise<Event[]> {
    return this.eventModel
      .find(publicEventFilter)
      .sort({ startDate: 1 })
      .limit(limit)
      .lean()
      .select('title startDate location coverImage slug');
  }

  async findEvents(
    q?: string,
    city?: string,
    type?: EventType,
    dateFrom?: string,
    dateTo?: string,
    page = 1,
    limit = 12,
  ): Promise<{ data: Event[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {
      ...publicEventFilter,
    };
    if (q) {
      delete filter['$or'];
      const term = { $regex: escapeRegExp(q), $options: 'i' };
      filter['$and'] = [
        publicEventFilter,
        {
          $or: [
            { title: term },
            { shortDescription: term },
            { description: term },
            { 'location.city': term },
          ],
        },
      ];
    }
    if (city) filter['location.city'] = { $regex: escapeRegExp(city), $options: 'i' };
    if (type) filter.eventType = type;
    if (dateFrom || dateTo) {
      filter.startDate = {
        ...(dateFrom ? { $gte: new Date(`${dateFrom}T00:00:00.000Z`) } : {}),
        ...(dateTo ? { $lte: new Date(`${dateTo}T23:59:59.999Z`) } : {}),
      };
    }
    const [data, total] = await Promise.all([
      this.eventModel.find(filter).sort({ startDate: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean().select(PUBLIC_EVENT_SEARCH_FIELDS),
      this.eventModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  async findVendors(
    q?: string,
    category?: VendorCategory,
    city?: string,
    price?: VendorPriceTier,
    page = 1,
    limit = 12,
  ): Promise<{ data: VendorProfile[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = { isActive: true };
    if (q) {
      const term = { $regex: escapeRegExp(q), $options: 'i' };
      filter['$or'] = [{ businessName: term }, { description: term }, { serviceArea: term }];
    }
    if (category) filter['category'] = category;
    if (city) filter.serviceArea = { $regex: escapeRegExp(city), $options: 'i' };
    if (price) filter['priceRange.min'] = this.getVendorPriceFilter(price);
    const [data, total] = await Promise.all([
      this.vendorModel.find(filter).sort({ rating: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean().select(PUBLIC_VENDOR_SEARCH_FIELDS),
      this.vendorModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  async findVenues(
    q?: string,
    city?: string,
    type?: VenueType,
    capacity?: number,
    page = 1,
    limit = 12,
  ): Promise<{ data: VenueProfile[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = { isActive: true };
    if (q) {
      const term = { $regex: escapeRegExp(q), $options: 'i' };
      filter['$or'] = [{ name: term }, { description: term }, { 'address.city': term }];
    }
    if (city) filter['address.city'] = { $regex: escapeRegExp(city), $options: 'i' };
    if (type) filter.type = type;
    if (capacity) filter.capacity = { $gte: capacity };
    const [data, total] = await Promise.all([
      this.venueModel.find(filter).sort({ rating: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean().select(PUBLIC_VENUE_SEARCH_FIELDS),
      this.venueModel.countDocuments(filter),
    ]);
    return { data, total, page, limit };
  }

  private getVendorPriceFilter(price: VendorPriceTier): Record<string, number> {
    switch (price) {
      case VendorPriceTier.BUDGET:
        return { $gte: 0, $lte: 1000 };
      case VendorPriceTier.STANDARD:
        return { $gt: 1000, $lte: 2500 };
      case VendorPriceTier.PREMIUM:
        return { $gt: 2500, $lte: 5000 };
      case VendorPriceTier.LUXURY:
        return { $gt: 5000 };
    }
  }
}
