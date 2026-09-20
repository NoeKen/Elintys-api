import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { Review, ReviewSchema } from './review.schema';
import { Event, EventSchema } from '../events/event.schema';
import { VendorProfile, VendorProfileSchema } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileSchema } from '../venues/venue.schema';
import { VenueBooking, VenueBookingSchema } from '../venues/venue.schema';
import { VendorRequest, VendorRequestSchema } from '../vendors/vendor.schema';
import { EventRegistration, EventRegistrationSchema } from '../event-registration/event-registration.schema';
import { TicketPurchase, TicketPurchaseSchema } from '../tickets/ticket.schema';
import { VenueManagerProfile, VenueManagerProfileSchema } from '../venue-managers/venue-manager.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Review.name, schema: ReviewSchema },
      // Lecture seule : vérification d'existence de la cible polymorphe.
      { name: Event.name, schema: EventSchema },
      { name: VendorProfile.name, schema: VendorProfileSchema },
      { name: VenueProfile.name, schema: VenueProfileSchema },
      { name: EventRegistration.name, schema: EventRegistrationSchema },
      { name: TicketPurchase.name, schema: TicketPurchaseSchema },
      { name: VendorRequest.name, schema: VendorRequestSchema },
      { name: VenueBooking.name, schema: VenueBookingSchema },
      { name: VenueManagerProfile.name, schema: VenueManagerProfileSchema },
    ]),
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
