import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Role, Roles } from '../../shared/decorators/roles.decorator';
import { UpsertVenueManagerDto } from './dto/upsert-venue-manager.dto';
import { VenueManagersService } from './venue-managers.service';

@ApiTags('Venue managers')
@ApiBearerAuth('access-token')
@Roles(Role.GESTIONNAIRE_SALLE)
@Controller('venue-managers')
export class VenueManagersController {
  constructor(private readonly service: VenueManagersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Mon profil professionnel gestionnaire (404 si absent)' })
  findMine(@CurrentUser() user: JwtPayload) {
    return this.service.findMine(user.sub);
  }

  @Put('me')
  @ApiOperation({ summary: 'Créer ou modifier mon profil professionnel sans créer de lieu' })
  upsertMine(@CurrentUser() user: JwtPayload, @Body() dto: UpsertVenueManagerDto) {
    return this.service.upsertMine(user.sub, dto);
  }
}
