import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event, EventDocument, EventStatus } from './event.schema';

@Injectable()
export class EventLifecycleScheduler {
  private readonly logger = new Logger(EventLifecycleScheduler.name);

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<EventDocument>,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'event-lifecycle-synchronization',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async synchronize(now = new Date()): Promise<void> {
    const completed = await this.eventModel
      .updateMany(
        {
          status: { $in: [EventStatus.PUBLISHED, EventStatus.ONGOING] },
          endDate: { $lte: now },
        },
        { $set: { status: EventStatus.COMPLETED, completedAt: now } },
      )
      .exec();

    const ongoing = await this.eventModel
      .updateMany(
        {
          status: EventStatus.PUBLISHED,
          startDate: { $lte: now },
          $or: [
            { endDate: { $gt: now } },
            { endDate: null },
            { endDate: { $exists: false } },
          ],
        },
        { $set: { status: EventStatus.ONGOING, startedAt: now } },
      )
      .exec();

    if (completed.modifiedCount > 0 || ongoing.modifiedCount > 0) {
      this.logger.log(
        `Cycle de vie synchronisé: ${ongoing.modifiedCount} en cours, ${completed.modifiedCount} terminés`,
      );
    }
  }
}
