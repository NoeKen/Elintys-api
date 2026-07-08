import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';
import { WaitlistEntry, WaitlistEntrySchema } from './waitlist.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: WaitlistEntry.name, schema: WaitlistEntrySchema }])],
  controllers: [WaitlistController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
