import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';
import { RolesGuard } from './shared/guards/roles.guard';
import { AllExceptionsFilter } from './shared/filters/http-exception.filter';
import { ConfigService } from '@nestjs/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const frontendUrl = configService.getOrThrow<string>('frontendUrl');
  const port = configService.getOrThrow<number>('port');
  const nodeEnv = configService.get<string>('nodeEnv');
  const enableSwagger = process.env.ENABLE_SWAGGER === 'true' || nodeEnv !== 'production';

  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  if (enableSwagger) {
    const config = new DocumentBuilder()
      .setTitle('Elintys API')
      .setDescription("Documentation officielle de l'API Elintys — Plateforme événementielle québécoise")
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          in: 'header',
        },
        'access-token',
      )
      .addTag('Auth', 'Inscription, connexion, déconnexion, refresh token')
      .addTag('Events', 'Création et gestion des événements')
      .addTag('Tickets', 'Types de billets et achats')
      .addTag('Vendors', 'Catalogue et profils prestataires')
      .addTag('Venues', 'Salles et espaces événementiels')
      .addTag('Guests', 'Gestion des invités par événement')
      .addTag('Reviews', 'Avis sur événements, prestataires et salles')
      .addTag('Favorites', 'Favoris par type de cible')
      .addTag('Discovery', 'Recherche et contenu mis en avant')
      .addTag('Payments', 'Sessions de paiement Stripe')
      .addTag('AI', "Fonctionnalités d'intelligence artificielle")
      .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
      customSiteTitle: 'Elintys API Docs',
    });

    console.log(`📖 Swagger disponible sur : http://localhost:${port}/api/docs`);
  }

  await app.listen(port);
  console.log(`🚀 Elintys API démarrée sur le port ${port} [${nodeEnv}]`);
}

bootstrap();
