import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ClientSession, Types } from 'mongoose';
import { EventRegistrationService } from './event-registration.service';
import {
  EventRegistration,
  EventRegistrationStatus,
} from './event-registration.schema';
import { Event } from '../events/event.schema';
import { IdempotencyService } from '../../shared/consistency/idempotency/idempotency.service';
import { EventAccessService } from '../events/event-access.service';
import { RegisterEventDto } from './dto/register-event.dto';
import { RegistrationAlreadyExistsError } from '../../shared/consistency/errors/consistency.errors';

let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate', 'session'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

const mockSession = {} as ClientSession;

describe('EventRegistrationService', () => {
  let service: EventRegistrationService;
  let registrationModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;
  let idempotencyService: { execute: jest.Mock };
  let eventAccessService: { buildActor: jest.Mock };

  const participantId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const registrationId = new Types.ObjectId().toString();
  const organizerId = new Types.ObjectId().toString();

  const mockEvent = (overrides = {}) => ({
    _id: eventId,
    organizer: { toString: () => organizerId },
    status: 'published',
    archivedAt: null,
    admissionModes: ['registration_only'],
    discoverability: 'public',
    accessPolicy: { type: 'open' },
    accessModelVersion: 2,
    ...overrides,
  });

  const mockRegistration = (overrides = {}) => ({
    _id: new Types.ObjectId(registrationId),
    eventId: new Types.ObjectId(eventId),
    participantId: new Types.ObjectId(participantId),
    status: EventRegistrationStatus.ACTIVE,
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  const makeDto = (overrides: Partial<RegisterEventDto> = {}): RegisterEventDto =>
    ({ eventId, ...overrides } as RegisterEventDto);

  const idempotencyPassthrough = (execute: jest.Mock) => {
    execute.mockImplementation(
      async (params: { operation: (s: ClientSession) => Promise<unknown> }) =>
        params.operation(mockSession),
    );
  };

  beforeEach(async () => {
    registrationModel = {
      create: jest.fn(),
      find: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
    };

    eventModel = {
      findById: jest.fn(),
    };

    idempotencyService = { execute: jest.fn() };
    eventAccessService = {
      buildActor: jest.fn().mockResolvedValue({ userId: participantId }),
    };

    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
    idempotencyPassthrough(idempotencyService.execute);

    testingModule = await Test.createTestingModule({
      providers: [
        EventRegistrationService,
        { provide: getModelToken(EventRegistration.name), useValue: registrationModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: IdempotencyService, useValue: idempotencyService },
        { provide: EventAccessService, useValue: eventAccessService },
      ],
    }).compile();

    service = testingModule.get<EventRegistrationService>(EventRegistrationService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── register ──
  describe('register', () => {
    it('crée une inscription et retourne le résultat', async () => {
      const reg = mockRegistration();
      registrationModel.create.mockResolvedValue([reg]);

      const result = await service.register(participantId, makeDto(), 'key-uuid-123');

      expect(registrationModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({
          eventId: expect.any(Types.ObjectId),
          participantId: expect.any(Types.ObjectId),
          status: EventRegistrationStatus.ACTIVE,
        })],
        { session: mockSession },
      );
      expect(result.status).toBe(EventRegistrationStatus.ACTIVE);
      expect(result.eventId).toBe(eventId);
    });

    it("passe participantId et idempotencyKey à IdempotencyService", async () => {
      registrationModel.create.mockResolvedValue([mockRegistration()]);

      await service.register(participantId, makeDto(), 'key-uuid-123', 'access-grant');

      expect(idempotencyService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'event-registration',
          actorId: participantId,
          idempotencyKey: 'key-uuid-123',
          payload: { eventId },
        }),
      );
      expect(eventAccessService.buildActor).toHaveBeenCalledWith(
        participantId,
        eventId,
        'access-grant',
        mockSession,
      );
    });

    it("rejoue un succès sans réévaluer l'état mutable de l'événement", async () => {
      const replayed = {
        _id: registrationId,
        eventId,
        status: EventRegistrationStatus.ACTIVE,
      };
      idempotencyService.execute.mockResolvedValueOnce(replayed);
      eventModel.findById.mockClear();

      await expect(service.register(participantId, makeDto(), 'replayed-key'))
        .resolves.toEqual(replayed);
      expect(eventModel.findById).not.toHaveBeenCalled();
      expect(eventAccessService.buildActor).not.toHaveBeenCalled();
      expect(registrationModel.create).not.toHaveBeenCalled();
    });

    it('lève NotFoundException si l\'événement est introuvable', async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.register(participantId, makeDto(), 'key-uuid-123')).rejects.toThrow(NotFoundException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it("lève NotFoundException si l'événement n'est pas publié", async () => {
      eventModel.findById.mockReturnValue(makeChainable(mockEvent({ status: 'draft' })));

      await expect(service.register(participantId, makeDto(), 'key-uuid-123')).rejects.toThrow(NotFoundException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it("lève NotFoundException si l'événement est archivé", async () => {
      eventModel.findById.mockReturnValue(makeChainable(mockEvent({ archivedAt: new Date() })));

      await expect(service.register(participantId, makeDto(), 'key-uuid-123')).rejects.toThrow(NotFoundException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it('lève BadRequestException si registration_only absent des admissionModes', async () => {
      eventModel.findById.mockReturnValue(makeChainable(mockEvent({ admissionModes: ['free_ticket'] })));

      await expect(service.register(participantId, makeDto(), 'key-uuid-123'))
        .rejects.toThrow(BadRequestException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it('lève ForbiddenException si la politique refuse l\'accès', async () => {
      eventAccessService.buildActor.mockResolvedValue({ userId: null });
      eventModel.findById.mockReturnValue(makeChainable(
        mockEvent({ accessPolicy: { type: 'registration_required' } }),
      ));

      await expect(service.register(participantId, makeDto(), 'key-uuid-123')).rejects.toThrow(ForbiddenException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it('propage RegistrationAlreadyExistsError sur doublon E11000 (eventId+participantId)', async () => {
      const e11000 = Object.assign(new Error('E11000'), {
        code: 11000,
        keyPattern: { eventId: 1, participantId: 1 },
      });
      registrationModel.create.mockRejectedValue(e11000);

      await expect(service.register(participantId, makeDto(), 'key-uuid-123'))
        .rejects.toBeInstanceOf(RegistrationAlreadyExistsError);
    });

    it('laisse passer une erreur DB inconnue sans la masquer', async () => {
      const unknown = Object.assign(new Error('E11000 autre index'), {
        code: 11000,
        keyPattern: { someOtherField: 1 },
      });
      registrationModel.create.mockRejectedValue(unknown);

      await expect(service.register(participantId, makeDto(), 'key-uuid-123')).rejects.not.toBeInstanceOf(
        RegistrationAlreadyExistsError,
      );
    });
  });

  // ── cancel ──
  describe('cancel', () => {
    it('annule une inscription active', async () => {
      registrationModel.findById.mockReturnValue(
        makeChainable(mockRegistration()),
      );
      registrationModel.findByIdAndUpdate.mockResolvedValue({});

      await expect(service.cancel(registrationId, participantId)).resolves.toBeUndefined();
      expect(registrationModel.findByIdAndUpdate).toHaveBeenCalledWith(
        registrationId,
        { status: EventRegistrationStatus.CANCELLED },
      );
    });

    it('retourne sans erreur si inscription déjà annulée (idempotence)', async () => {
      registrationModel.findById.mockReturnValue(
        makeChainable(mockRegistration({ status: EventRegistrationStatus.CANCELLED })),
      );

      await expect(service.cancel(registrationId, participantId)).resolves.toBeUndefined();
      expect(registrationModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("lève NotFoundException si l'inscription est introuvable", async () => {
      registrationModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.cancel(registrationId, participantId)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si l'utilisateur n'est pas propriétaire", async () => {
      const otherId = new Types.ObjectId().toString();
      registrationModel.findById.mockReturnValue(makeChainable(mockRegistration()));

      await expect(service.cancel(registrationId, otherId)).rejects.toThrow(ForbiddenException);
    });
  });

  // ── findByEvent ──
  describe('findByEvent', () => {
    it('retourne les inscriptions actives pour un organisateur', async () => {
      eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
      registrationModel.find.mockReturnValue(makeChainable([mockRegistration()]));
      registrationModel.countDocuments.mockResolvedValue(1);

      const result = await service.findByEvent(eventId, organizerId);

      expect(registrationModel.find).toHaveBeenCalledWith({
        eventId: expect.any(Types.ObjectId),
        status: EventRegistrationStatus.ACTIVE,
      });
      expect(result).toEqual(expect.objectContaining({ total: 1, page: 1, limit: 25 }));
      expect(result.data).toHaveLength(1);
    });

    it("lève NotFoundException si l'événement est introuvable", async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.findByEvent(eventId, organizerId)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si l'utilisateur n'est pas l'organisateur", async () => {
      await expect(service.findByEvent(eventId, 'autre-id')).rejects.toThrow(ForbiddenException);
    });
  });

  // ── findMine ──
  describe('findMine', () => {
    it('retourne les inscriptions actives du participant', async () => {
      registrationModel.find.mockReturnValue(makeChainable([mockRegistration()]));
      registrationModel.countDocuments.mockResolvedValue(1);

      const result = await service.findMine(participantId);

      expect(registrationModel.find).toHaveBeenCalledWith({
        participantId: expect.any(Types.ObjectId),
        status: EventRegistrationStatus.ACTIVE,
      });
      expect(result).toEqual(expect.objectContaining({ total: 1, page: 1, limit: 25 }));
      expect(result.data).toHaveLength(1);
    });

    it('retourne un tableau vide si aucune inscription active', async () => {
      registrationModel.find.mockReturnValue(makeChainable([]));

      const result = await service.findMine(participantId);

      expect(result.data).toHaveLength(0);
    });
  });
});
