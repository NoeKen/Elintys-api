import { BadRequestException, Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EventAccessService } from '../src/modules/events/event-access.service';
import { validateEventAccessConfiguration } from '../src/modules/events/event-access.policy';
import { UpdateEventAccessConfigurationDto } from '../src/modules/events/dto/update-event-access-configuration.dto';

@Controller('event-access-contract')
class EventAccessContractController {
  private readonly access = new EventAccessService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    new JwtService(),
    new ConfigService(),
  );

  @Post()
  async validate(@Body() dto: UpdateEventAccessConfigurationDto) {
    const accessPolicy = await this.access.preparePolicy(dto.accessPolicy);
    const result = validateEventAccessConfiguration({ ...dto, accessPolicy });
    if (!result.valid) throw new BadRequestException(result.errors);
    return { valid: true };
  }
}

describe('Event access HTTP contract (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventAccessContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => app.close());

  it.each([
    ['public-open', { discoverability: 'public', accessPolicy: { type: 'open' }, admissionModes: ['registration_only'] }],
    ['unlisted-paid', { discoverability: 'unlisted', accessPolicy: { type: 'open' }, admissionModes: ['paid_ticket'] }],
    ['code', { discoverability: 'unlisted', accessPolicy: { type: 'access_code', code: 'secret-123' }, admissionModes: ['registration_only'] }],
    ['domain', { discoverability: 'public', accessPolicy: { type: 'email_domain', allowedDomains: ['entreprise.ca'] }, admissionModes: ['free_ticket'] }],
    ['manual', { discoverability: 'private', accessPolicy: { type: 'manual_approval' }, admissionModes: ['registration_only'] }],
    ['guest-list', { discoverability: 'private', accessPolicy: { type: 'guest_list' }, admissionModes: ['invitation'] }],
    ['invitation', { discoverability: 'unlisted', accessPolicy: { type: 'invitation_token' }, admissionModes: ['invitation'] }],
    ['mixed', { discoverability: 'public', accessPolicy: { type: 'open' }, admissionModes: ['paid_ticket', 'invitation'] }],
  ])('accepte le scénario %s', async (_name, body) => {
    await request(app.getHttpServer()).post('/event-access-contract').send(body).expect(201, { valid: true });
  });

  it.each([
    [{ discoverability: 'public', accessPolicy: { type: 'open' }, admissionModes: [] }],
    [{ discoverability: 'private', accessPolicy: { type: 'open' }, admissionModes: ['free'] }],
    [{ discoverability: 'public', accessPolicy: { type: 'invitation_token' }, admissionModes: ['paid_ticket'] }],
    [{ discoverability: 'public', accessPolicy: { type: 'open', allowedDomains: ['entreprise.ca'] }, admissionModes: ['free'] }],
    [{ discoverability: 'public', accessPolicy: { type: 'open' }, admissionModes: ['free'], internal: true }],
  ])('rejette une configuration incohérente ou un champ non prévu', async (body) => {
    await request(app.getHttpServer()).post('/event-access-contract').send(body).expect(400);
  });
});
