import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { DiscoveryService } from './discovery.service';
import { Public } from '../../shared/decorators/public.decorator';
import { THROTTLE_TIERS } from '../../config/throttle.config';
import {
  FeaturedDiscoveryDto,
  QueryDiscoveryEventsDto,
  QueryDiscoveryVendorsDto,
  QueryDiscoveryVenuesDto,
  SearchDiscoveryDto,
} from './dto/query-discovery.dto';

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
  search(@Query() query: SearchDiscoveryDto) {
    // Le DTO valide et borne : `page`/`limit` sont des entiers dans une plage
    // fermée, `q` une chaîne bornée. `forbidNonWhitelisted` rejette au passage
    // toute clé inattendue — un `?q[$ne]=` ne peut plus atteindre le filtre.
    return this.discoveryService.search(query.q, query.page, query.limit);
  }

  @Get('featured')
  @ApiOperation({ summary: 'Événements mis en avant' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 6 })
  @ApiResponse({ status: 200, description: 'Liste des événements mis en avant' })
  featured(@Query() query: FeaturedDiscoveryDto) {
    return this.discoveryService.featuredEvents(query.limit);
  }

  @Get('events')
  @ApiOperation({ summary: 'Lister les événements publics paginés' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 12 })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'événements' })
  findEvents(@Query() query: QueryDiscoveryEventsDto) {
    return this.discoveryService.findEvents(query.q, query.city, query.page, query.limit);
  }

  @Get('vendors')
  @ApiOperation({ summary: 'Lister les prestataires actifs paginés' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 12 })
  @ApiResponse({ status: 200, description: 'Liste paginée de prestataires' })
  findVendors(@Query() query: QueryDiscoveryVendorsDto) {
    return this.discoveryService.findVendors(query.q, query.category, query.page, query.limit);
  }

  @Get('venues')
  @ApiOperation({ summary: 'Lister les salles actives paginées' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 12 })
  @ApiResponse({ status: 200, description: 'Liste paginée de salles' })
  findVenues(@Query() query: QueryDiscoveryVenuesDto) {
    return this.discoveryService.findVenues(query.q, query.city, query.page, query.limit);
  }
}
