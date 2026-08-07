import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { DiscoveryService } from './discovery.service';
import { Public } from '../../shared/decorators/public.decorator';
import { THROTTLE_TIERS } from '../../config/throttle.config';

@ApiTags('Discovery')
@Public()
// Recherche et filtres : plus coûteux qu'une lecture de fiche, donc plafond
// intermédiaire — nettement au-dessus d'une navigation normale, en dessous du
// catalogue.
@Throttle({ default: THROTTLE_TIERS.PUBLIC_SEARCH })
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('search')
  @ApiOperation({ summary: 'Rechercher des événements par mot-clé' })
  @ApiQuery({ name: 'q', required: true, type: String, example: 'gala montréal' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiResponse({ status: 200, description: 'Résultats de recherche paginés' })
  search(
    @Query('q') q: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.discoveryService.search(
      q ?? '',
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get('featured')
  @ApiOperation({ summary: 'Événements mis en avant' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 6 })
  @ApiResponse({ status: 200, description: 'Liste des événements mis en avant' })
  featured(@Query('limit') limit?: string) {
    return this.discoveryService.featuredEvents(limit ? parseInt(limit, 10) : 6);
  }

  @Get('events')
  @ApiOperation({ summary: 'Lister les événements publics paginés' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 12 })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'événements' })
  findEvents(
    @Query('q') q?: string,
    @Query('city') city?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.discoveryService.findEvents(q, city, page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 12);
  }

  @Get('vendors')
  @ApiOperation({ summary: 'Lister les prestataires actifs paginés' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 12 })
  @ApiResponse({ status: 200, description: 'Liste paginée de prestataires' })
  findVendors(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.discoveryService.findVendors(q, category, page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 12);
  }

  @Get('venues')
  @ApiOperation({ summary: 'Lister les salles actives paginées' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 12 })
  @ApiResponse({ status: 200, description: 'Liste paginée de salles' })
  findVenues(
    @Query('q') q?: string,
    @Query('city') city?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.discoveryService.findVenues(q, city, page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 12);
  }
}
