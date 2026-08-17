import {
  AdmissionMode,
  EventAccessPolicyType,
  EventDiscoverability,
  EventLocationType,
  EventType,
} from '../event.schema';

export interface PublicEventMedia {
  url?: string;
  publicId?: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface PublicEventLocation {
  type: EventLocationType;
  name?: string;
  address?: string;
  city?: string;
  province?: string;
  postalCode?: string;
}

export interface PublicEventVenue {
  _id: string;
  name: string;
  type: string;
  description?: string;
  address: {
    street: string;
    city: string;
    province?: string;
    postalCode?: string;
  };
  capacity: number;
  photos: string[];
  amenities: string[];
  rating: number;
  reviewCount: number;
}

export interface PublicEventProvider {
  _id: string;
  businessName: string;
  category: string;
  description?: string;
  photos: string[];
  serviceArea: string;
  rating: number;
  reviewCount: number;
}

export interface PublicEventTicketType {
  _id: string;
  name: string;
  price: number;
  isFree: boolean;
  quantity: number;
  sold: number;
  description?: string;
}

export interface PublicRelatedEvent {
  _id: string;
  slug: string;
  title: string;
  shortDescription?: string;
  eventType?: EventType;
  coverImage?: PublicEventMedia | string;
  startDate: Date;
  endDate?: Date;
  location?: PublicEventLocation;
}

export interface PublicEventDetail {
  _id: string;
  slug: string;
  title: string;
  shortDescription?: string;
  description?: string;
  eventType?: EventType;
  coverImage?: PublicEventMedia | string;
  gallery: PublicEventMedia[];
  startDate: Date;
  endDate?: Date;
  timezone: string;
  dateIsTentative: boolean;
  location?: PublicEventLocation;
  capacity?: number;
  discoverability: EventDiscoverability.PUBLIC | EventDiscoverability.UNLISTED;
  accessPolicy: {
    type: EventAccessPolicyType;
    requiresAuthentication?: boolean;
    hasAccessCode?: boolean;
  };
  admissionModes: AdmissionMode[];
  organizer?: { name: string };
  venue?: PublicEventVenue;
  providers: PublicEventProvider[];
  ticketTypes: PublicEventTicketType[];
  relatedEvents: PublicRelatedEvent[];
  updatedAt?: Date;
}
