import { Body, Controller, INestApplication, Patch, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RegisterDto } from '../src/modules/auth/dto/register.dto';
import { UpdateProfileDto } from '../src/modules/auth/dto/update-profile.dto';
import { ChangePasswordDto } from '../src/modules/auth/dto/change-password.dto';
import { UpdateNotificationPreferencesDto } from '../src/modules/auth/dto/update-notification-preferences.dto';
import { AddRoleDto } from '../src/modules/auth/dto/add-role.dto';

@Controller('account-settings-contract')
class AccountSettingsContractController {
  @Post('register')
  register(@Body() dto: RegisterDto) { return dto; }

  @Patch('profile')
  profile(@Body() dto: UpdateProfileDto) { return dto; }

  @Post('password')
  password(@Body() dto: ChangePasswordDto) { return dto; }

  @Patch('preferences')
  preferences(@Body() dto: UpdateNotificationPreferencesDto) { return dto; }

  @Post('roles')
  roles(@Body() dto: AddRoleDto) { return dto; }
}

describe('Account settings HTTP contracts (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountSettingsContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
  });

  afterAll(async () => app.close());

  it('refuse ADMIN dès l’inscription publique', async () => {
    await request(app.getHttpServer())
      .post('/account-settings-contract/register')
      .send({
        fullName: 'Attaquant Test',
        email: 'attaquant@example.ca',
        password: 'Secret123!',
        roles: ['admin'],
      })
      .expect(400);
  });

  it.each(['organisateur', 'prestataire', 'gestionnaire_salle', 'participant'])(
    'accepte le rôle public %s à l’inscription',
    async (role) => {
      await request(app.getHttpServer())
        .post('/account-settings-contract/register')
        .send({
          fullName: 'Compte Test',
          email: 'compte@example.ca',
          password: 'Secret123!',
          roles: [role],
        })
        .expect(201);
    },
  );

  it('refuse le mass assignment du profil', async () => {
    await request(app.getHttpServer())
      .patch('/account-settings-contract/profile')
      .send({ firstName: 'Ana', lastName: 'Test', roles: ['admin'] })
      .expect(400);
  });

  it('refuse une préférence libre inconnue', async () => {
    await request(app.getHttpServer())
      .patch('/account-settings-contract/preferences')
      .send({ securityEmails: false })
      .expect(400);
  });

  it.each(['admin', 'participant', 'inconnu'])(
    'refuse l’ajout du rôle %s',
    async (role) => {
      await request(app.getHttpServer())
        .post('/account-settings-contract/roles')
        .send({ role })
        .expect(400);
    },
  );

  it('applique la politique de longueur au changement de mot de passe', async () => {
    await request(app.getHttpServer())
      .post('/account-settings-contract/password')
      .send({ currentPassword: 'court', newPassword: 'court' })
      .expect(400);
  });
});
