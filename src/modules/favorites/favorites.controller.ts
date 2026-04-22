import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { FavoritesService } from './favorites.service';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { FavoriteTargetType } from './favorite.schema';

@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Post()
  add(@CurrentUser() user: JwtPayload, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.add(user.sub, dto);
  }

  @Get()
  findMine(@CurrentUser() user: JwtPayload, @Query('type') type?: FavoriteTargetType) {
    return this.favoritesService.findMyFavorites(user.sub, type);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: JwtPayload, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.remove(user.sub, dto);
  }
}
