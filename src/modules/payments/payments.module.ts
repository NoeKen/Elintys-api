import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { TicketsModule } from '../tickets/tickets.module';
import { EmailsModule } from '../emails/emails.module';
import { Event, EventSchema } from '../events/event.schema';
import { EventsModule } from '../events/events.module';
import { ConsistencyModule } from '../../shared/consistency/consistency.module';
import {
  StripePaymentFinalization,
  StripePaymentFinalizationSchema,
} from './stripe-payment-finalization.schema';
import { PaymentProvidersModule } from './providers/payment-providers.module';
import { PayPalWebhookController } from './paypal-webhook.controller';
import { PayPalWebhookService } from './providers/paypal/paypal-webhook.service';
import {
  PayPalWebhookEvent,
  PayPalWebhookEventSchema,
} from './providers/paypal/paypal-webhook-event.schema';

@Module({
  imports: [
    TicketsModule,
    EmailsModule,
    EventsModule,
    ConsistencyModule,
    PaymentProvidersModule,
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      { name: StripePaymentFinalization.name, schema: StripePaymentFinalizationSchema },
      { name: PayPalWebhookEvent.name, schema: PayPalWebhookEventSchema },
    ]),
  ],
  controllers: [PaymentsController, PayPalWebhookController],
  providers: [PaymentsService, PayPalWebhookService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
