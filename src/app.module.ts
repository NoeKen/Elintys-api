import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';

import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { VenuesModule } from './modules/venues/venues.module';
import { GuestsModule } from './modules/guests/guests.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { AiModule } from './modules/ai/ai.module';
import { EmailsModule } from './modules/emails/emails.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('mongoUri'),
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    EmailsModule,
    AuthModule,
    EventsModule,
    TicketsModule,
    VendorsModule,
    VenuesModule,
    GuestsModule,
    PaymentsModule,
    ReviewsModule,
    FavoritesModule,
    DiscoveryModule,
    AiModule,
  ],
})
export class AppModule {}
