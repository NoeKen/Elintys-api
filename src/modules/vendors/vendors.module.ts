import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorProfile, VendorProfileSchema, VendorRequest, VendorRequestSchema } from './vendor.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { User, UserSchema } from '../auth/user.schema';
import { Event, EventSchema } from '../events/event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VendorProfile.name, schema: VendorProfileSchema },
      { name: VendorRequest.name, schema: VendorRequestSchema },
      { name: User.name, schema: UserSchema },
      { name: Event.name, schema: EventSchema },
    ]),
    NotificationsModule,
  ],
  controllers: [VendorsController],
  providers: [VendorsService],
  exports: [VendorsService, MongooseModule],
})
export class VendorsModule {}
