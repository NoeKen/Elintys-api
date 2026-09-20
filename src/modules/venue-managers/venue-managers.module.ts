import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenueManagerProfile, VenueManagerProfileSchema } from './venue-manager.schema';
import { VenueManagersService } from './venue-managers.service';
import { VenueManagersController } from './venue-managers.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: VenueManagerProfile.name, schema: VenueManagerProfileSchema }])],
  controllers: [VenueManagersController],
  providers: [VenueManagersService],
  exports: [VenueManagersService, MongooseModule],
})
export class VenueManagersModule {}
