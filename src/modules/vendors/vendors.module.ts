import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorProfile, VendorProfileSchema, VendorRequest, VendorRequestSchema } from './vendor.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: VendorProfile.name, schema: VendorProfileSchema },
    { name: VendorRequest.name, schema: VendorRequestSchema },
  ])],
  controllers: [VendorsController],
  providers: [VendorsService],
  exports: [VendorsService, MongooseModule],
})
export class VendorsModule {}
