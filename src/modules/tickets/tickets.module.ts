import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TicketTypesController, TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketType, TicketTypeSchema, TicketPurchase, TicketPurchaseSchema } from './ticket.schema';
import { EventsModule } from '../events/events.module';
import { ConsistencyModule } from '../../shared/consistency/consistency.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketType.name, schema: TicketTypeSchema },
      { name: TicketPurchase.name, schema: TicketPurchaseSchema },
    ]),
    EventsModule,
    ConsistencyModule,
  ],
  controllers: [TicketTypesController, TicketsController],
  providers: [TicketsService],
  exports: [TicketsService, MongooseModule],
})
export class TicketsModule {}
