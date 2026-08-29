import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventRegistrationController } from './event-registration.controller';
import { EventRegistrationService } from './event-registration.service';
import {
  EventRegistration,
  EventRegistrationSchema,
} from './event-registration.schema';
import { EventsModule } from '../events/events.module';
import { ConsistencyModule } from '../../shared/consistency/consistency.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventRegistration.name, schema: EventRegistrationSchema },
    ]),
    EventsModule,
    ConsistencyModule,
  ],
  controllers: [EventRegistrationController],
  providers: [EventRegistrationService],
  exports: [EventRegistrationService],
})
export class EventRegistrationModule {}
