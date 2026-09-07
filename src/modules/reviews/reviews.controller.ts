import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ParseObjectIdPipe } from '../../shared/pipes/parse-object-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { QueryReviewsDto, ReviewTargetParamsDto } from './dto/query-reviews.dto';
import { ReviewTargetType } from './review.schema';
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
  @ApiResponse({ status: 404, description: 'Cible introuvable (REVIEW_TARGET_NOT_FOUND)' })
  @ApiResponse({ status: 409, description: 'Avis déjà soumis (REVIEW_ALREADY_SUBMITTED)' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(user.sub, dto);
  }

  @Public()
  @Get(':targetType/:targetId')
  @ApiOperation({ summary: 'Lister les avis pour une cible' })
  @ApiParam({ name: 'targetType', enum: ReviewTargetType, description: 'Type de cible' })
  @ApiParam({ name: 'targetId', description: 'MongoDB ObjectId de la cible' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'avis' })
  findForTarget(@Param() params: ReviewTargetParamsDto, @Query() query: QueryReviewsDto) {
    // `targetType` est validé contre l'énumération : une valeur inventée
    // renvoyait auparavant 200 avec une liste vide, présentant une entrée
    // invalide comme un résultat légitime.
    return this.reviewsService.findForTarget(
      params.targetType,
      params.targetId,
      query.page,
      query.limit,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Supprimer son avis' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'avis' })
  @ApiResponse({ status: 204, description: 'Avis supprimé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: "Avis d'un autre auteur (ACCESS_DENIED)" })
  @ApiResponse({ status: 404, description: 'Avis introuvable (REVIEW_NOT_FOUND)' })
  remove(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.reviewsService.remove(id, user.sub);
  }
}
