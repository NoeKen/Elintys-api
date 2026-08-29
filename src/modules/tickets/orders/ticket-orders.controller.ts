import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { TicketOrdersService } from './ticket-orders.service';
import { CreateTicketOrderDto } from './dto/create-ticket-order.dto';
import { QueryTicketOrdersDto } from './dto/query-ticket-orders.dto';
import { CurrentUser, JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { ParseObjectIdPipe } from '../../../shared/pipes/parse-object-id.pipe';
import { Role, Roles } from '../../../shared/decorators/roles.decorator';

/**
 * API de commande de billetterie payante.
 *
 * RÈGLES DE SÉCURITÉ APPLIQUÉES ICI
 * ---------------------------------
 * - L'identité de l'acheteur vient toujours de `user.sub` (JWT). Aucun endpoint
 *   n'accepte `buyerId`, `participantId`, `paid`, `paymentStatus`, `sold` ou
 *   `reserved` depuis le client.
 * - Aucun endpoint ne permet de déclarer une commande payée. `sync-payment`
 *   demande l'issue au fournisseur ; le client ne fait que déclencher.
 * - Aucun endpoint de simulation n'est exposé : le scénario de test transite
 *   par le DTO de création et n'est accepté que lorsque le fournisseur simulé
 *   est autorisé (dev uniquement).
 */
@ApiTags('TicketOrders')
@ApiBearerAuth('access-token')
@Controller('ticket-orders')
export class TicketOrdersController {
  constructor(private readonly ticketOrdersService: TicketOrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer une commande de billets payants et réserver le stock' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Clé unique de cette tentative de commande' })
  @ApiHeader({ name: 'X-Event-Access-Grant', required: false, description: "Jeton d'accès court terme" })
  @ApiResponse({ status: 201, description: 'Commande créée, stock réservé' })
  @ApiResponse({ status: 400, description: 'Lignes invalides ou stock insuffisant' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: "Accès refusé par la politique de l'événement" })
  @ApiResponse({ status: 404, description: 'Type de billet ou événement introuvable' })
  @ApiResponse({ status: 409, description: 'Commande déjà en cours de traitement' })
  @ApiResponse({ status: 503, description: 'Paiement des billets indisponible' })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTicketOrderDto,
    @Headers('idempotency-key') idempotencyKey = '',
    @Headers('x-event-access-grant') accessGrant?: string,
  ) {
    return this.ticketOrdersService.createOrder(user.sub, dto, idempotencyKey, accessGrant);
  }

  @Get('me')
  @ApiOperation({ summary: 'Lister mes commandes de billets' })
  @ApiResponse({ status: 200, description: 'Liste paginée des commandes' })
  findMine(@CurrentUser() user: JwtPayload, @Query() query: QueryTicketOrdersDto) {
    return this.ticketOrdersService.findMine(user.sub, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consulter une de mes commandes' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la commande' })
  @ApiResponse({ status: 200, description: 'Commande' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseObjectIdPipe) id: string) {
    return this.ticketOrdersService.findOne(id, user.sub);
  }

  @Post(':id/sync-payment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Synchroniser l'issue du paiement depuis le fournisseur",
    description:
      "Le serveur interroge le fournisseur de paiement. Le client ne fournit jamais de statut de paiement.",
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la commande' })
  @ApiResponse({ status: 200, description: 'Commande à jour' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: 'Paiement tardif nécessitant une revue manuelle' })
  syncPayment(@CurrentUser() user: JwtPayload, @Param('id', ParseObjectIdPipe) id: string) {
    return this.ticketOrdersService.syncPayment(id, user.sub);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Annuler ma commande en attente de paiement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la commande' })
  @ApiResponse({ status: 200, description: 'Commande annulée, capacité libérée' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: "La commande n'est plus en attente de paiement" })
  cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseObjectIdPipe) id: string) {
    return this.ticketOrdersService.cancelOrder(id, user.sub);
  }
}

/**
 * Exploitation : déclenchement manuel du balayage d'expiration.
 *
 * La correction du système ne dépend PAS de cet endpoint (l'expiration
 * paresseuse suffit) ; il existe pour l'observabilité et le nettoyage des
 * commandes abandonnées dont personne ne relit plus le type de billet.
 */
@ApiTags('TicketOrders')
@ApiBearerAuth('access-token')
@Controller('ticket-orders-maintenance')
export class TicketOrdersMaintenanceController {
  constructor(private readonly ticketOrdersService: TicketOrdersService) {}

  @Post('expire')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Expirer les commandes dont la réservation est périmée (admin)' })
  @ApiResponse({ status: 200, description: 'Rapport de balayage' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  expire() {
    return this.ticketOrdersService.sweepExpiredOrders();
  }
}
