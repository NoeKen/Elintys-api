import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { Event, EventSchema } from './event.schema';
import { MediaModule } from '../media/media.module';
import { EventMediaService } from './event-media.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
    MediaModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, EventMediaService],
  exports: [EventsService, MongooseModule],
})
export class EventsModule {}
