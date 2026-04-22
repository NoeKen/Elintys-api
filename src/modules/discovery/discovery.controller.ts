import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { DiscoveryService } from './discovery.service';
import { Public } from '../../shared/decorators/public.decorator';

@ApiTags('Discovery')
@Public()
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
}
