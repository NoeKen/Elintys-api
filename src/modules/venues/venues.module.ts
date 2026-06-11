import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { VenueProfile, VenueProfileSchema, VenueBooking, VenueBookingSchema } from './venue.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { User, UserSchema } from '../auth/user.schema';
import { Event, EventSchema } from '../events/event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VenueProfile.name, schema: VenueProfileSchema },
      { name: VenueBooking.name, schema: VenueBookingSchema },
      { name: User.name, schema: UserSchema },
      { name: Event.name, schema: EventSchema },
    ]),
    NotificationsModule,
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService, MongooseModule],
})
export class VenuesModule {}
