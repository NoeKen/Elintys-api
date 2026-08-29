import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TicketTypesController, TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketType, TicketTypeSchema, TicketPurchase, TicketPurchaseSchema } from './ticket.schema';
import { EventsModule } from '../events/events.module';
import { ConsistencyModule } from '../../shared/consistency/consistency.module';
import { PaymentProvidersModule } from '../payments/providers/payment-providers.module';
import { TicketOrder, TicketOrderSchema } from './orders/ticket-order.schema';
import { TicketHold, TicketHoldSchema } from './orders/ticket-hold.schema';
import { TicketInventoryService } from './orders/ticket-inventory.service';
import { TicketOrdersService } from './orders/ticket-orders.service';
import {
  TicketOrdersController,
  TicketOrdersMaintenanceController,
} from './orders/ticket-orders.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TicketType.name, schema: TicketTypeSchema },
      { name: TicketPurchase.name, schema: TicketPurchaseSchema },
      { name: TicketOrder.name, schema: TicketOrderSchema },
      { name: TicketHold.name, schema: TicketHoldSchema },
    ]),
    EventsModule,
    ConsistencyModule,
    PaymentProvidersModule,
  ],
  controllers: [
    TicketTypesController,
    TicketsController,
    TicketOrdersController,
    TicketOrdersMaintenanceController,
  ],
  providers: [TicketsService, TicketInventoryService, TicketOrdersService],
  exports: [TicketsService, TicketInventoryService, TicketOrdersService, MongooseModule],
})
export class TicketsModule {}
