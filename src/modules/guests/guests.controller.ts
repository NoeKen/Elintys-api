import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { GuestsService } from './guests.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Guests')
@ApiBearerAuth('access-token')
@Controller('events/:eventId/guests')
@Roles(Role.ORGANISATEUR, Role.ADMIN)
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Post()
  @ApiOperation({ summary: 'Ajouter un invité à un événement' })
  @ApiParam({ name: 'eventId', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 201, description: 'Invité ajouté' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  create(
    @Param('eventId') eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateGuestDto,
  ) {
    return this.guestsService.create(eventId, user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lister les invités d\'un événement' })
  @ApiParam({ name: 'eventId', description: 'MongoDB ObjectId de l\'événement' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'invités' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
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
  @ApiOperation({ summary: 'Mettre à jour le statut ou la note d\'un invité' })
  @ApiParam({ name: 'eventId', description: 'MongoDB ObjectId de l\'événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'invité' })
  @ApiResponse({ status: 200, description: 'Invité mis à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Invité introuvable' })
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
  @ApiOperation({ summary: 'Retirer un invité de l\'événement' })
  @ApiParam({ name: 'eventId', description: 'MongoDB ObjectId de l\'événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'invité' })
  @ApiResponse({ status: 204, description: 'Invité retiré' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Invité introuvable' })
  remove(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.guestsService.remove(id, eventId, user.sub);
  }
}
