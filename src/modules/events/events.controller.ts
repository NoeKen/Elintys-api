import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { QueryEventDto } from './dto/query-event.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Events')
@ApiBearerAuth('access-token')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Créer un nouvel événement' })
  @ApiResponse({ status: 201, description: 'Événement créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateEventDto) {
    return this.eventsService.create(user.sub, dto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lister les événements' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'published', 'cancelled', 'completed'] })
  @ApiQuery({ name: 'visibility', required: false, enum: ['public', 'private', 'invite_only'] })
  @ApiQuery({ name: 'city', required: false, type: String, example: 'Montréal' })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'événements' })
  findAll(@Query() query: QueryEventDto) {
    return this.eventsService.findAll(query);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un événement par ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement trouvé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  findOne(@Param('id') id: string) {
    return this.eventsService.findOne(id);
  }

  @Put(':id')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement mis à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.update(id, user.sub, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Supprimer un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 204, description: 'Événement supprimé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.remove(id, user.sub);
  }

  @Patch(':id/publish')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Publier un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement publié' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  publish(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.publish(id, user.sub);
  }

  @Patch(':id/cancel')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Annuler un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement annulé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  cancel(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.cancel(id, user.sub);
  }
}
