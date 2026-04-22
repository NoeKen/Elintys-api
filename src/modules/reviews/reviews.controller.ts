import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';

@ApiTags('Reviews')
@ApiBearerAuth('access-token')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @ApiOperation({ summary: 'Laisser un avis sur un événement, prestataire ou salle' })
  @ApiResponse({ status: 201, description: 'Avis créé' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 409, description: 'Avis déjà existant pour cette cible' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(user.sub, dto);
  }

  @Public()
  @Get(':targetType/:targetId')
  @ApiOperation({ summary: 'Lister les avis pour une cible' })
  @ApiParam({ name: 'targetType', enum: ['event', 'vendor', 'venue'], description: 'Type de cible' })
  @ApiParam({ name: 'targetId', description: 'MongoDB ObjectId de la cible' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'avis' })
  findForTarget(
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviewsService.findForTarget(
      targetType,
      targetId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Supprimer son avis' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'avis' })
  @ApiResponse({ status: 204, description: 'Avis supprimé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Avis introuvable' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.reviewsService.remove(id, user.sub);
  }
}
