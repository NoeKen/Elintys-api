import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@Controller('ticket-types')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post('events/:eventId')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  createType(
    @Param('eventId') eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTicketTypeDto,
  ) {
    return this.ticketsService.createTicketType(eventId, user.sub, dto);
  }

  @Public()
  @Get('events/:eventId')
  findTypes(@Param('eventId') eventId: string) {
    return this.ticketsService.findTicketTypes(eventId);
  }

  @Put(':id')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  updateType(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTicketTypeDto,
  ) {
    return this.ticketsService.updateTicketType(id, user.sub, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  removeType(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.ticketsService.removeTicketType(id, user.sub);
  }

  @Get('my')
  myTickets(@CurrentUser() user: JwtPayload) {
    return this.ticketsService.findMyTickets(user.sub);
  }
}
