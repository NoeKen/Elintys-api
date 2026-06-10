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
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Venues')
@ApiBearerAuth('access-token')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post()
  @Roles(Role.GESTIONNAIRE_SALLE, Role.ADMIN)
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
  @ApiResponse({ status: 200, description: 'Liste paginée de salles' })
  findAll(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.venuesService.findAll(page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 20);
  }

  @Get('me')
  @Roles(Role.GESTIONNAIRE_SALLE)
  @ApiOperation({ summary: 'Mon profil de salle (gestionnaire connecté)' })
  @ApiResponse({ status: 200, description: 'Profil de salle' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  @ApiResponse({ status: 404, description: 'Profil introuvable' })
  myProfile(@CurrentUser() user: JwtPayload) {
    return this.venuesService.findMyProfile(user.sub);
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
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RespondVenueBookingDto,
  ) {
    return this.venuesService.respondToBooking(bookingId, user.sub, dto);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Récupérer une salle par ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la salle' })
  @ApiResponse({ status: 200, description: 'Salle trouvée' })
  @ApiResponse({ status: 404, description: 'Salle introuvable' })
  findOne(@Param('id') id: string) {
    return this.venuesService.findOne(id);
  }

  @Put(':id')
  @Roles(Role.GESTIONNAIRE_SALLE, Role.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour une salle' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la salle' })
  @ApiResponse({ status: 200, description: 'Salle mise à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Salle introuvable' })
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateVenueDto) {
    return this.venuesService.update(id, user.sub, dto);
  }

  @Post(':eventId/bookings')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Demander une réservation de salle pour un événement' })
  @ApiParam({ name: 'eventId' })
  @ApiResponse({ status: 201, description: 'Demande de réservation créée' })
  requestBooking(
    @Param('eventId') eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVenueBookingDto,
  ) {
    return this.venuesService.requestBooking(eventId, user.sub, dto);
  }

  @Get(':eventId/bookings')
  @ApiOperation({ summary: "Réservations d'un événement (authentifié)" })
  @ApiParam({ name: 'eventId' })
  @ApiResponse({ status: 200, description: 'Liste des réservations' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  listBookingsByEvent(@Param('eventId') eventId: string) {
    return this.venuesService.listBookingsByEvent(eventId);
  }
}
