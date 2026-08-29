import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ElintysThrottlerGuard } from './shared/guards/elintys-throttler.guard';
import configuration from './config/configuration';
import { THROTTLE_TIERS } from './config/throttle.config';

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
import { InvitationsModule } from './modules/invitations/invitations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { HealthModule } from './modules/health/health.module';
import { EventRegistrationModule } from './modules/event-registration/event-registration.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const uri = configService.get<string>('MONGODB_URI');

        if (!uri) {
          throw new Error(
            'MONGODB_URI is not defined. Please set it in your environment variables.',
          );
        }

        return { uri };
      },
    }),
    // Tier global généreux (PUBLIC_READ). Les endpoints sensibles surchargent
    // via @Throttle({ default: THROTTLE_TIERS.AUTH_STRICT }) — cf. throttle.config.ts.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: THROTTLE_TIERS.PUBLIC_READ.ttl,
        limit: THROTTLE_TIERS.PUBLIC_READ.limit,
      },
    ]),
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
    InvitationsModule,
    NotificationsModule,
    WaitlistModule,
    HealthModule,
    EventRegistrationModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ElintysThrottlerGuard }],
})
export class AppModule {}
