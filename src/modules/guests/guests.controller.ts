import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { GuestsService } from './guests.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@Controller('events/:eventId/guests')
@Roles(Role.ORGANISATEUR, Role.ADMIN)
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Post()
  create(
    @Param('eventId') eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateGuestDto,
  ) {
    return this.guestsService.create(eventId, user.sub, dto);
  }

  @Get()
  findAll(
    @Param('eventId') eventId: string,
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.guestsService.findAll(
      eventId,
      user.sub,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Put(':id')
  update(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateGuestDto,
  ) {
    return this.guestsService.update(id, eventId, user.sub, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.guestsService.remove(id, eventId, user.sub);
  }
}
