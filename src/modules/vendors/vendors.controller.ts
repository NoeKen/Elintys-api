import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { QueryVendorDto } from './dto/query-vendor.dto';
import { CreateVendorRequestDto } from './dto/create-request.dto';
import { RespondVendorRequestDto } from './dto/respond-request.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';

@ApiTags('Vendors')
@ApiBearerAuth('access-token')
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Post()
  @Roles(Role.PRESTATAIRE, Role.ADMIN)
  @ApiOperation({ summary: 'Créer un profil prestataire' })
  @ApiResponse({ status: 201, description: 'Profil prestataire créé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  @ApiResponse({ status: 409, description: 'Profil déjà existant' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVendorDto) {
    return this.vendorsService.create(user.sub, dto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lister les prestataires' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'category', required: false, enum: ['photographe', 'traiteur', 'decorateur', 'animateur', 'dj', 'sonorisation', 'autre'] })
  @ApiResponse({ status: 200, description: 'Liste paginée de prestataires' })
  findAll(@Query() query: QueryVendorDto) {
    return this.vendorsService.findAll(query);
  }

  @Get('me')
  @Roles(Role.PRESTATAIRE)
  @ApiOperation({ summary: 'Mon profil prestataire' })
  @ApiResponse({ status: 200, description: 'Profil prestataire de l\'utilisateur connecté' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  @ApiResponse({ status: 404, description: 'Profil introuvable' })
  myProfile(@CurrentUser() user: JwtPayload) {
    return this.vendorsService.findMyProfile(user.sub);
  }

  // ⚠️ IMPORTANT: requests/my MUST come before :id and :eventId/requests to avoid route conflicts
  @Get('requests/my')
  @Roles(Role.PRESTATAIRE)
  @ApiOperation({ summary: 'Mes demandes reçues (prestataire)' })
  @ApiResponse({ status: 200, description: 'Liste des demandes reçues' })
  listMyRequests(@CurrentUser() user: JwtPayload) {
    return this.vendorsService.listMyRequests(user.sub);
  }

  @Patch('requests/:requestId/respond')
  @Roles(Role.PRESTATAIRE)
  @ApiOperation({ summary: 'Accepter ou refuser une demande' })
  @ApiParam({ name: 'requestId' })
  @ApiResponse({ status: 200, description: 'Réponse enregistrée' })
  respondToRequest(@Param('requestId') requestId: string, @CurrentUser() user: JwtPayload, @Body() dto: RespondVendorRequestDto) {
    return this.vendorsService.respondToRequest(requestId, user.sub, dto);
  }

  @Delete('requests/:requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Annuler une demande (organisateur)' })
  @ApiParam({ name: 'requestId' })
  @ApiResponse({ status: 204, description: 'Demande annulée' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  cancelRequest(@Param('requestId') requestId: string, @CurrentUser() user: JwtPayload) {
    return this.vendorsService.cancelRequest(requestId, user.sub);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un prestataire par ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId du prestataire' })
  @ApiResponse({ status: 200, description: 'Prestataire trouvé' })
  @ApiResponse({ status: 404, description: 'Prestataire introuvable' })
  findOne(@Param('id') id: string) {
    return this.vendorsService.findOne(id);
  }

  @Put(':id')
  @Roles(Role.PRESTATAIRE, Role.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour un profil prestataire' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId du prestataire' })
  @ApiResponse({ status: 200, description: 'Profil mis à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Prestataire introuvable' })
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateVendorDto) {
    return this.vendorsService.update(id, user.sub, dto);
  }

  @Post(':eventId/requests')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Envoyer une demande à un prestataire pour un événement' })
  @ApiParam({ name: 'eventId', description: 'ID de l\'événement' })
  @ApiResponse({ status: 201, description: 'Demande créée' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  createRequest(@Param('eventId') eventId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateVendorRequestDto) {
    return this.vendorsService.createRequest(eventId, user.sub, dto);
  }

  @Get(':eventId/requests')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Lister les demandes prestataires d\'un événement (authentifié)' })
  @ApiParam({ name: 'eventId' })
  @ApiResponse({ status: 200, description: 'Liste des demandes' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  listRequestsByEvent(@Param('eventId') eventId: string, @CurrentUser() user: JwtPayload) {
    return this.vendorsService.listRequestsByEvent(eventId, user.sub);
  }
}
