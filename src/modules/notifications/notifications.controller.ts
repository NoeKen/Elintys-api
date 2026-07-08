import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('me/unread-count')
  @ApiOperation({ summary: 'Nombre de notifications non lues' })
  getUnreadCount(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.countUnread(user.sub);
  }

  @Get('me')
  findMine(
    @CurrentUser() user: JwtPayload,
    @Query('unread') unread?: string,
    @Query('page') page?: string,
  ) {
    return this.notificationsService.findByUser(user.sub, {
      unreadOnly: unread === 'true',
      page: page ? parseInt(page, 10) : 1,
    });
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.notificationsService.markRead(id, user.sub);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.markAllRead(user.sub);
  }
}
