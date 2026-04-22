import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';

@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVenueDto) {
    return this.venuesService.create(user.sub, dto);
  }

  @Public()
  @Get()
  findAll(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.venuesService.findAll(page ? parseInt(page, 10) : 1, limit ? parseInt(limit, 10) : 20);
  }

  @Public()
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.venuesService.findOne(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateVenueDto) {
    return this.venuesService.update(id, user.sub, dto);
  }
}
