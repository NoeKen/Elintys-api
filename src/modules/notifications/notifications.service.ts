import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FlattenMaps, Model, Types } from 'mongoose';
import { Notification, NotificationDocument, NotificationType } from './notification.schema';
import { ErrorCodes } from '../../shared/constants/error-codes';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
  ) {}

  async create(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
  ): Promise<NotificationDocument> {
    return this.notificationModel.create({
      userId: new Types.ObjectId(userId),
      type,
      payload,
    });
  }

  async findByUser(
    userId: string,
    options: { unreadOnly?: boolean; page?: number; limit?: number } = {},
  ): Promise<FlattenMaps<NotificationDocument>[]> {
    const { unreadOnly = false, page = 1, limit = 20 } = options;
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
    };
    if (unreadOnly) {
      filter['read'] = false;
    }

    return this.notificationModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();
  }

  async markRead(notificationId: string, userId: string): Promise<void> {
    const notification = await this.notificationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(notificationId),
          userId: new Types.ObjectId(userId),
        },
        { read: true },
      )
      .exec();
    if (!notification) throw new NotFoundException(ErrorCodes.NOTIFICATION_NOT_FOUND);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notificationModel
      .updateMany(
        { userId: new Types.ObjectId(userId), read: false },
        { read: true },
      )
      .exec();
  }

  async countUnread(userId: string): Promise<{ count: number }> {
    const count = await this.notificationModel.countDocuments({
      userId: new Types.ObjectId(userId),
      read: false,
    });
    return { count };
  }
}
