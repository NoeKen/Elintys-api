import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { CreateVenueBookingDto } from './dto/create-booking.dto';
import { RespondVenueBookingDto } from './dto/respond-booking.dto';
import { QueryVenueDto } from './dto/query-venue.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ParseObjectIdPipe } from '../../shared/pipes/parse-object-id.pipe';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Venues')
@ApiBearerAuth('access-token')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post()
  // Route strictement personnelle : ADMIN n'y apporterait aucune capacité.
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Créer un profil de salle' })
  @ApiResponse({ status: 201, description: 'Salle créée avec succès' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVenueDto) {
    return this.venuesService.create(user.sub, dto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lister les salles' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'type', required: false, enum: ['conference', 'reception', 'studio', 'restaurant', 'rooftop', 'spectacle', 'other'] })
  @ApiQuery({ name: 'city', required: false, type: String, example: 'Montréal' })
  @ApiQuery({ name: 'capacity', required: false, type: Number, description: 'Capacité minimale' })
  @ApiResponse({ status: 200, description: 'Liste paginée de salles' })
  findAll(@Query() query: QueryVenueDto) {
    return this.venuesService.findAll(query);
  }

  @Get('me')
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Mon profil de salle (gestionnaire connecté)' })
  @ApiResponse({ status: 200, description: 'Profil de salle' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  @ApiResponse({ status: 404, description: 'Profil introuvable (VENUE_PROFILE_NOT_FOUND) — le client doit basculer en mode création' })
  myProfile(@CurrentUser() user: JwtPayload) {
    return this.venuesService.findMyProfile(user.sub);
  }

  /**
   * ⚠️ IMPORTANT : `me` DOIT être déclaré avant `:id`.
   *
   * Sans cette route, `PUT /venues/me` était capté par `PUT /venues/:id` avec
   * `id = "me"`, produisant un `CastError` Mongoose donc une 500. L'identité
   * vient exclusivement de `user.sub`.
   */
  @Put('me')
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Mettre à jour MA fiche lieu' })
  @ApiResponse({ status: 200, description: 'Fiche mise à jour' })
  @ApiResponse({ status: 400, description: 'Payload invalide' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  @ApiResponse({ status: 404, description: 'Profil introuvable (VENUE_PROFILE_NOT_FOUND)' })
  updateMyProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateVenueDto) {
    return this.venuesService.updateMyProfile(user.sub, dto);
  }

  @Get('bookings/my')
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Mes demandes de réservation reçues' })
  @ApiResponse({ status: 200, description: 'Liste des réservations reçues' })
  listMyBookings(@CurrentUser() user: JwtPayload) {
    return this.venuesService.listMyBookings(user.sub);
  }

  @Patch('bookings/:bookingId/respond')
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Confirmer ou refuser une réservation' })
  @ApiParam({ name: 'bookingId' })
  @ApiResponse({ status: 200, description: 'Réponse enregistrée' })
  respondToBooking(
    @Param('bookingId', ParseObjectIdPipe) bookingId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RespondVenueBookingDto,
  ) {
    return this.venuesService.respondToBooking(bookingId, user.sub, dto);
  }

  @Patch('bookings/:bookingId/cancel')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Annuler une réservation appartenant à son événement' })
  @ApiParam({ name: 'bookingId' })
  cancelBooking(@Param('bookingId', ParseObjectIdPipe) bookingId: string, @CurrentUser() user: JwtPayload) {
    return this.venuesService.cancelBooking(bookingId, user.sub, user.roles);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Récupérer une salle par ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la salle' })
  @ApiResponse({ status: 200, description: 'Salle trouvée' })
  @ApiResponse({ status: 404, description: 'Salle introuvable' })
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.venuesService.findOne(id);
  }

  @Put(':id')
  // Voir vendors : aucune modération admin de fiche tierce dans le produit.
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Mettre à jour une salle' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la salle' })
  @ApiResponse({ status: 200, description: 'Salle mise à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Salle introuvable' })
  update(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateVenueDto) {
    return this.venuesService.update(id, user.sub, dto);
  }

  @Post(':eventId/bookings')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Demander une réservation de salle pour un événement' })
  @ApiParam({ name: 'eventId' })
  @ApiResponse({ status: 201, description: 'Demande de réservation créée' })
  requestBooking(
    @Param('eventId', ParseObjectIdPipe) eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVenueBookingDto,
  ) {
    return this.venuesService.requestBooking(eventId, user.sub, dto, user.roles);
  }

  @Get(':eventId/bookings')
  @ApiOperation({ summary: "Réservations d'un événement (authentifié)" })
  @ApiParam({ name: 'eventId' })
  @ApiResponse({ status: 200, description: 'Liste des réservations' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  listBookingsByEvent(@Param('eventId', ParseObjectIdPipe) eventId: string, @CurrentUser() user: JwtPayload) {
    return this.venuesService.listBookingsByEvent(eventId, user.sub, user.roles);
  }
}
