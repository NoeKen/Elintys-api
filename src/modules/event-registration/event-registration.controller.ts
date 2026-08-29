import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { EventRegistrationService } from './event-registration.service';
import { RegisterEventDto } from './dto/register-event.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ParseObjectIdPipe } from '../../shared/pipes/parse-object-id.pipe';
import { QueryEventRegistrationsDto } from './dto/query-event-registrations.dto';

@ApiTags('EventRegistrations')
@ApiBearerAuth('access-token')
@Controller('event-registrations')
export class EventRegistrationController {
  constructor(private readonly service: EventRegistrationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "S'inscrire à un événement (admission registration_only)" })
  @ApiResponse({ status: 201, description: 'Inscription créée ou rejouée' })
  @ApiResponse({ status: 400, description: 'Événement non disponible à l\'inscription' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé par la politique de l\'événement' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  @ApiResponse({ status: 409, description: 'Inscription active déjà existante' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: "Clé unique de cette tentative d'inscription" })
  @ApiHeader({ name: 'X-Event-Access-Grant', required: false, description: "Preuve d'accès temporaire pour un événement proté par code" })
  register(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterEventDto,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-event-access-grant') accessGrant?: string,
  ) {
    return this.service.register(user.sub, dto, idempotencyKey ?? '', accessGrant);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Annuler une inscription' })
  @ApiParam({ name: 'id', description: "MongoDB ObjectId de l'inscription" })
  @ApiResponse({ status: 204, description: 'Inscription annulée' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Inscription introuvable' })
  cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseObjectIdPipe) id: string,
  ) {
    return this.service.cancel(id, user.sub);
  }

  @Get('me')
  @ApiOperation({ summary: 'Lister mes inscriptions actives' })
  @ApiResponse({ status: 200, description: 'Liste des inscriptions actives' })
  findMine(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryEventRegistrationsDto,
  ) {
    return this.service.findMine(user.sub, query);
  }

  @Get('events/:eventId')
  @ApiOperation({ summary: "Lister les inscrits à un événement (organisateur)" })
  @ApiParam({ name: 'eventId', description: "MongoDB ObjectId de l'événement" })
  @ApiResponse({ status: 200, description: 'Liste des inscriptions actives' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  findByEvent(
    @CurrentUser() user: JwtPayload,
    @Param('eventId', ParseObjectIdPipe) eventId: string,
    @Query() query: QueryEventRegistrationsDto,
  ) {
    return this.service.findByEvent(eventId, user.sub, query);
  }
}
