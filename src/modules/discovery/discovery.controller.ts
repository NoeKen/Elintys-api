import { Controller, Get, Query } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { Public } from '../../shared/decorators/public.decorator';

@Public()
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('search')
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
  featured(@Query('limit') limit?: string) {
    return this.discoveryService.featuredEvents(limit ? parseInt(limit, 10) : 6);
  }
}
