import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { FavoritesService } from './favorites.service';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { FavoriteTargetType } from './favorite.schema';

@ApiTags('Favorites')
@ApiBearerAuth('access-token')
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Post()
  @ApiOperation({ summary: 'Ajouter un favori' })
  @ApiResponse({ status: 201, description: 'Favori ajouté' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 409, description: 'Déjà dans les favoris' })
  add(@CurrentUser() user: JwtPayload, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.add(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Mes favoris (filtrables par type)' })
  @ApiQuery({ name: 'type', required: false, enum: FavoriteTargetType, description: 'Filtrer par type de cible' })
  @ApiResponse({ status: 200, description: 'Liste de mes favoris' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  findMine(@CurrentUser() user: JwtPayload, @Query('type') type?: FavoriteTargetType) {
    return this.favoritesService.findMyFavorites(user.sub, type);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirer un favori' })
  @ApiResponse({ status: 204, description: 'Favori retiré' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 404, description: 'Favori introuvable' })
  remove(@CurrentUser() user: JwtPayload, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.remove(user.sub, dto);
  }
}
