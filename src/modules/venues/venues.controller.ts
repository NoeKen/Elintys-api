import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';

@ApiTags('Venues')
@ApiBearerAuth('access-token')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post()
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
  @ApiOperation({ summary: 'Mettre à jour une salle' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de la salle' })
  @ApiResponse({ status: 200, description: 'Salle mise à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Salle introuvable' })
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateVenueDto) {
    return this.venuesService.update(id, user.sub, dto);
  }
}
