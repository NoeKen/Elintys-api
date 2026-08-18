import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { Event, EventSchema } from './event.schema';
import { MediaModule } from '../media/media.module';
import { EventMediaService } from './event-media.service';
import { JwtModule } from '@nestjs/jwt';
import { EventAccessService } from './event-access.service';
import {
  EventAccessRequest,
  EventAccessRequestSchema,
} from './event-access-request.schema';
import { User, UserSchema } from '../auth/user.schema';
import { Guest, GuestSchema } from '../guests/guest.schema';
import { TicketType, TicketTypeSchema } from '../tickets/ticket.schema';
import { Invitation, InvitationSchema } from '../invitations/invitation.schema';
import { VenueProfile, VenueProfileSchema } from '../venues/venue.schema';
import {
  VendorProfile,
  VendorProfileSchema,
  VendorRequest,
  VendorRequestSchema,
} from '../vendors/vendor.schema';
import { InvitationsModule } from '../invitations/invitations.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      { name: EventAccessRequest.name, schema: EventAccessRequestSchema },
      { name: User.name, schema: UserSchema },
      { name: Guest.name, schema: GuestSchema },
      { name: TicketType.name, schema: TicketTypeSchema },
      { name: Invitation.name, schema: InvitationSchema },
      { name: VenueProfile.name, schema: VenueProfileSchema },
      { name: VendorProfile.name, schema: VendorProfileSchema },
      { name: VendorRequest.name, schema: VendorRequestSchema },
    ]),
    JwtModule.register({}),
    MediaModule,
    InvitationsModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, EventMediaService, EventAccessService],
  exports: [EventsService, EventAccessService, MongooseModule],
})
export class EventsModule {}
