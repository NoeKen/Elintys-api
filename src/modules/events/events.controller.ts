import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import { EventsService } from './events.service';
import { EventMediaService } from './event-media.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { QueryEventDto } from './dto/query-event.dto';
import { DeleteEventGalleryImageDto } from './dto/delete-event-gallery-image.dto';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles, Role } from '../../shared/decorators/roles.decorator';
import {
  MEDIA_MAX_FILE_SIZE,
  MEDIA_MAX_GALLERY_IMAGES,
} from '../media/media.constants';
import { EventAccessService } from './event-access.service';
import { UpdateEventAccessConfigurationDto } from './dto/update-event-access-configuration.dto';
import { ReviewEventAccessRequestDto, VerifyEventAccessCodeDto } from './dto/event-access.dto';
import { ParseObjectIdPipe } from '../../shared/pipes/parse-object-id.pipe';

@ApiTags('Events')
@ApiBearerAuth('access-token')
@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly eventMediaService: EventMediaService,
    private readonly eventAccessService: EventAccessService,
  ) {}

  @Post()
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Créer un nouvel événement' })
  @ApiResponse({ status: 201, description: 'Événement créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateEventDto) {
    return this.eventsService.create(user.sub, dto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lister les événements' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'city', required: false, type: String, example: 'Montréal' })
  @ApiResponse({ status: 200, description: 'Liste paginée d\'événements' })
  findAll(@Query() query: QueryEventDto) {
    return this.eventsService.findAll(query);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'Compter les événements publics par catégorie' })
  @ApiResponse({ status: 200, description: 'Agrégation des catégories publiques' })
  getCategoryCounts() {
    return this.eventsService.getPublicCategoryCounts();
  }

  @Get('my')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Mes événements (organisateur connecté)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'published', 'cancelled', 'completed'] })
  @ApiResponse({ status: 200, description: 'Liste paginée des événements de l\'organisateur' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Rôle insuffisant' })
  findMyEvents(@CurrentUser() user: JwtPayload, @Query() query: QueryEventDto) {
    return this.eventsService.findByOrganizer(user.sub, query);
  }

  @Public()
  @Get('slug/:slug')
  @ApiOperation({ summary: 'Récupérer un événement par slug' })
  @ApiParam({ name: 'slug', description: 'Slug de l\'événement, ex: gala-de-charite-2025' })
  @ApiResponse({ status: 200, description: 'Événement trouvé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  findBySlug(@Param('slug') slug: string) {
    return this.eventsService.findBySlug(slug);
  }

  @Public()
  @Post(':id/access/code/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  verifyAccessCode(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: VerifyEventAccessCodeDto,
    @Req() request: Request,
  ) {
    return this.eventAccessService.verifyCode(id, dto.code, request.headers['x-request-id'] as string | undefined);
  }

  @Public()
  @Get('access/:token')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  resolveAccessGrant(@Param('token') token: string) {
    return this.eventAccessService.resolveAccessGrant(token);
  }

  @Post(':id/access/domain/check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  checkAccessDomain(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload, @Req() request: Request) {
    return this.eventAccessService.checkDomain(id, user.sub, request.headers['x-request-id'] as string | undefined);
  }

  @Get(':id/access')
  getAuthorizedEvent(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() request: Request,
  ) {
    const grant = request.headers['x-event-access-grant'];
    return this.eventAccessService.findAuthorizedEvent(
      id,
      user.sub,
      typeof grant === 'string' ? grant : undefined,
      request.headers['x-request-id'] as string | undefined,
    );
  }

  @Post(':id/access/request')
  @Throttle({ default: { ttl: 10 * 60_000, limit: 3 } })
  requestAccess(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload, @Req() request: Request) {
    return this.eventAccessService.requestAccess(id, user.sub, request.headers['x-request-id'] as string | undefined);
  }

  @Get(':id/access/requests')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  listAccessRequests(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.eventAccessService.listRequests(id, { userId: user.sub, roles: user.roles });
  }

  @Patch(':id/access/requests/:requestId')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  reviewAccessRequest(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('requestId') requestId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReviewEventAccessRequestDto,
  ) {
    return this.eventAccessService.reviewRequest(id, requestId, { userId: user.sub, roles: user.roles }, dto.status);
  }

  @Put(':id/access-configuration')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  updateAccessConfiguration(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateEventAccessConfigurationDto,
  ) {
    return this.eventAccessService.updateConfiguration(id, { userId: user.sub, roles: user.roles }, dto);
  }

  @Get(':id/publish-readiness')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  getPublishReadiness(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.getPublishReadiness(id, user.sub);
  }

  @Get(':id')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Récupérer un événement par ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement trouvé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  findOne(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.findOne(id, user.sub);
  }

  @Put(':id')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement mis à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.update(id, user.sub, dto);
  }

  @Patch(':id')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Mettre à jour partiellement un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l’événement' })
  @ApiResponse({ status: 200, description: 'Événement mis à jour' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  patch(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.update(id, user.sub, dto);
  }

  @Post(':eventId/cover')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MEDIA_MAX_FILE_SIZE, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Téléverser ou remplacer la couverture' })
  uploadCover(
    @Param('eventId', ParseObjectIdPipe) eventId: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.eventMediaService.uploadCover(eventId, user.sub, file);
  }

  @Delete(':eventId/cover')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Supprimer la couverture de l’événement' })
  deleteCover(
    @Param('eventId', ParseObjectIdPipe) eventId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.eventMediaService.deleteCover(eventId, user.sub);
  }

  @Post(':eventId/gallery')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseInterceptors(
    FilesInterceptor('files', MEDIA_MAX_GALLERY_IMAGES, {
      storage: memoryStorage(),
      limits: {
        fileSize: MEDIA_MAX_FILE_SIZE,
        files: MEDIA_MAX_GALLERY_IMAGES,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          maxItems: MEDIA_MAX_GALLERY_IMAGES,
        },
      },
    },
  })
  @ApiOperation({ summary: 'Ajouter des images à la galerie' })
  uploadGallery(
    @Param('eventId', ParseObjectIdPipe) eventId: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.eventMediaService.uploadGallery(eventId, user.sub, files);
  }

  @Delete(':eventId/gallery')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Supprimer une image de la galerie' })
  deleteGalleryImage(
    @Param('eventId', ParseObjectIdPipe) eventId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: DeleteEventGalleryImageDto,
  ) {
    return this.eventMediaService.deleteGalleryImage(
      eventId,
      user.sub,
      dto.publicId,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Supprimer un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 204, description: 'Événement supprimé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  remove(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.remove(id, user.sub);
  }

  @Patch(':id/publish')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Publier un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement publié' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  publish(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.publish(id, user.sub);
  }

  @Patch(':id/cancel')
  @Roles(Role.ORGANISATEUR, Role.ADMIN)
  @ApiOperation({ summary: 'Annuler un événement' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId de l\'événement' })
  @ApiResponse({ status: 200, description: 'Événement annulé' })
  @ApiResponse({ status: 401, description: 'Non authentifié' })
  @ApiResponse({ status: 403, description: 'Accès refusé' })
  @ApiResponse({ status: 404, description: 'Événement introuvable' })
  cancel(@Param('id', ParseObjectIdPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.eventsService.cancel(id, user.sub);
  }
}
