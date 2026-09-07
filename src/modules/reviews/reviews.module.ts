import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { Review, ReviewSchema } from './review.schema';
import { Event, EventSchema } from '../events/event.schema';
import { VendorProfile, VendorProfileSchema } from '../vendors/vendor.schema';
import { VenueProfile, VenueProfileSchema } from '../venues/venue.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Review.name, schema: ReviewSchema },
      // Lecture seule : vérification d'existence de la cible polymorphe.
      { name: Event.name, schema: EventSchema },
      { name: VendorProfile.name, schema: VendorProfileSchema },
      { name: VenueProfile.name, schema: VenueProfileSchema },
    ]),
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
