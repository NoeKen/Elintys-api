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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Tickets')
@ApiBearerAuth('access-token')
@Controller('ticket-types')
export class TicketTypesController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post('events/:eventId')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Créer un type de billet pour un événement' })
  @ApiParam({ name: 'eventId', description: "MongoDB ObjectId de l'événement" })
  @ApiResponse({ status: 201, description: 'Type de billet créé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  createType(
    @Param('eventId') eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTicketTypeDto,
  ) {
    return this.ticketsService.createTicketType(eventId, user.sub, dto);
  }

  @Public()
  @Get('events/:eventId')
  @ApiOperation({ summary: "Lister les types de billets d'un événement" })
  @ApiParam({ name: 'eventId', description: "MongoDB ObjectId de l'événement" })
  @ApiResponse({ status: 200, description: 'Liste des types de billets' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  findTypes(@Param('eventId') eventId: string) {
    return this.ticketsService.findTicketTypes(eventId);
  }

  @Put(':id')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour un type de billet' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId du type de billet' })
  @ApiResponse({ status: 200, description: 'Type de billet mis à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Type de billet introuvable' })
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
  @ApiOperation({ summary: 'Supprimer un type de billet' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId du type de billet' })
  @ApiResponse({ status: 204, description: 'Type de billet supprimé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Type de billet introuvable' })
  removeType(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.ticketsService.removeTicketType(id, user.sub);
  }
}

@ApiTags('Tickets')
@ApiBearerAuth('access-token')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get('my')
  @ApiOperation({ summary: 'Mes billets achetés' })
  @ApiResponse({ status: 200, description: "Liste des billets de l'utilisateur connecté" })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  myTickets(@CurrentUser() user: JwtPayload) {
    return this.ticketsService.findMyTickets(user.sub);
  }

  @Post('purchase')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Acheter des billets gratuits directement' })
  @ApiResponse({ status: 201, description: 'Billets créés avec succès' })
  @ApiResponse({ status: 400, description: 'Billet payant ou stock insuffisant' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 404, description: 'Type de billet introuvable' })
  purchase(@CurrentUser() user: JwtPayload, @Body() dto: PurchaseTicketDto) {
    return this.ticketsService.purchase(user.sub, dto);
  }

  @Get('scan/:qrCode')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Scanner un billet à l\'entrée d\'un événement' })
  @ApiParam({ name: 'qrCode', description: 'Code QR du billet au format XXXX-XXXX-XXXX' })
  @ApiResponse({ status: 200, description: 'Résultat du scan' })
  @ApiResponse({ status: 400, description: 'Billet non valide' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé — non organisateur de cet événement' })
  @ApiResponse({ status: 404, description: 'Code QR introuvable' })
  scan(@Param('qrCode') qrCode: string, @CurrentUser() user: JwtPayload) {
    return this.ticketsService.scan(qrCode, user.sub);
  }
}
