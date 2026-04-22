import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { VenueProfile, VenueProfileSchema } from './venue.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: VenueProfile.name, schema: VenueProfileSchema }])],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService, MongooseModule],
})
export class VenuesModule {}
