import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { TicketsModule } from '../tickets/tickets.module';
import { EmailsModule } from '../emails/emails.module';
import { Event, EventSchema } from '../events/event.schema';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    TicketsModule,
    EmailsModule,
    EventsModule,
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
