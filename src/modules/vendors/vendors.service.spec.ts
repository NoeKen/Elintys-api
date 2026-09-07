import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { VendorsService } from './vendors.service';
import { VendorProfile, VendorCategory, VendorRequest, VendorRequestSchema, VendorRequestStatus, VendorRequestSource } from './vendor.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailsService } from '../emails/emails.service';
import { User } from '../auth/user.schema';
import { Event } from '../events/event.schema';
import { VendorPriceTier } from './dto/query-vendor.dto';
import { NotificationType } from '../notifications/notification.schema';

/** Laisse se résoudre les envois « fire-and-forget » déclenchés par le service. */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const makeChainable = (value: unknown) => {
  const chain: Record<string, unknown> = {};
  ['lean', 'select', 'sort', 'skip', 'limit', 'populate'].forEach(
    (m) => { chain[m] = jest.fn().mockReturnValue(chain); },
  );
  chain['then'] = (res?: (v: unknown) => unknown) => Promise.resolve(value).then(res);
  chain['catch'] = (rej?: (e: unknown) => unknown) => Promise.resolve(value).catch(rej);
  return chain;
};

describe('VendorsService', () => {
  let service: VendorsService;
  let vendorModel: Record<string, jest.Mock>;
  let vendorRequestModel: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;
  let emailsService: Record<string, jest.Mock>;

  const userId = new Types.ObjectId().toString();
  const vendorUserId = new Types.ObjectId().toString();
  const vendorId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const requestId = new Types.ObjectId().toString();

  const mockVendor = (overrides = {}) => ({
    _id: vendorId,
    businessName: 'Photo Pro',
    category: VendorCategory.PHOTOGRAPHE,
    user: { toString: () => userId },
    isActive: true,
    rating: 4.5,
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  const mockRequest = (overrides = {}) => ({
    _id: requestId,
    event: new Types.ObjectId(eventId),
    organizer: { toString: () => userId },
    vendor: new Types.ObjectId(vendorId),
    status: VendorRequestStatus.PENDING,
    source: VendorRequestSource.PLATFORM,
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    vendorModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };

    vendorRequestModel = {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      create: jest.fn(),
    };

    vendorModel.find.mockReturnValue(makeChainable([mockVendor()]));
    vendorModel.findById.mockReturnValue(makeChainable(mockVendor()));
    vendorModel.findOne.mockReturnValue(makeChainable(null));
    vendorModel.countDocuments.mockResolvedValue(1);

    vendorRequestModel.find.mockReturnValue(makeChainable([mockRequest()]));
    vendorRequestModel.findOne.mockReturnValue(makeChainable(null));
    vendorRequestModel.findById.mockReturnValue(makeChainable(mockRequest()));
    vendorRequestModel.findByIdAndUpdate.mockReturnValue(makeChainable(mockRequest()));
    vendorRequestModel.findByIdAndDelete.mockResolvedValue(null);

    notificationsService = { create: jest.fn().mockResolvedValue(undefined) };
    emailsService = {
      sendRequestAccepted: jest.fn().mockResolvedValue(undefined),
      sendNewRequest: jest.fn().mockResolvedValue(undefined),
    };

    testingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
        { provide: getModelToken(VendorRequest.name), useValue: vendorRequestModel },
        { provide: getModelToken(User.name), useValue: { findById: jest.fn().mockReturnValue(makeChainable({ email: 'org@test.com', fullName: 'Org' })) } },
        {
          provide: getModelToken(Event.name),
          useValue: {
            findById: jest.fn().mockReturnValue(
              makeChainable({
                title: 'Test Event',
                organizer: { toString: () => userId },
              }),
            ),
          },
        },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: EmailsService, useValue: emailsService },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') } },
      ],
    }).compile();

    service = testingModule.get<VendorsService>(VendorsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ──
  describe('create', () => {
    it('crée un profil prestataire et le retourne', async () => {
      const dto = { businessName: 'Photo Pro', category: VendorCategory.PHOTOGRAPHE };
      vendorModel.create.mockResolvedValue(mockVendor(dto));

      const result = await service.create(userId, dto as never);

      expect(vendorModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessName: 'Photo Pro' }),
      );
      expect(result).toBeDefined();
    });

    it('lève ConflictException si un profil existe déjà pour ce compte', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable({ _id: vendorId }));

      await expect(
        service.create(userId, { businessName: 'Photo Pro' } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── findAll ──
  describe('findAll', () => {
    it('retourne une liste paginée de prestataires actifs', async () => {
      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(vendorModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
      );
    });

    it('filtre par catégorie si fournie', async () => {
      vendorModel.find.mockReturnValue(makeChainable([]));
      vendorModel.countDocuments.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20, category: VendorCategory.TRAITEUR });

      expect(vendorModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ category: VendorCategory.TRAITEUR }),
      );
    });

    it('filtre par ville et gamme de prix si fournies', async () => {
      await service.findAll({
        city: 'Montréal',
        price: VendorPriceTier.STANDARD,
      });

      expect(vendorModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceArea: { $regex: 'Montréal', $options: 'i' },
          'priceRange.min': { $gt: 1000, $lte: 2500 },
        }),
      );
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('retourne le profil prestataire correspondant à l\'ID', async () => {
      const result = await service.findOne(vendorId);

      expect((result as unknown as Record<string, unknown>)._id).toBe(vendorId);
    });

    it('lève NotFoundException si le prestataire n\'existe pas', async () => {
      vendorModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.findOne('id-inexistant')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findMyProfile ──
  describe('findMyProfile', () => {
    it('retourne le profil de l\'utilisateur connecté', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable(mockVendor()));

      const result = await service.findMyProfile(userId);

      expect(result).toBeDefined();
    });

    it('lève NotFoundException si aucun profil n\'existe pour cet utilisateur', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable(null));

      const otherUserId = new Types.ObjectId().toString();
      await expect(service.findMyProfile(otherUserId)).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ──
  describe('update', () => {
    it('met à jour et retourne le profil modifié', async () => {
      const dto = { businessName: 'Photo Pro Elite' };
      const updated = mockVendor(dto);
      vendorModel.findByIdAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.update(vendorId, userId, dto as never);

      expect(result.businessName).toBe('Photo Pro Elite');
    });

    it('lève ForbiddenException si l\'utilisateur n\'est pas le propriétaire', async () => {
      await expect(
        service.update(vendorId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lève NotFoundException si le prestataire n\'existe pas', async () => {
      vendorModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.update('id-inexistant', userId, {})).rejects.toThrow(NotFoundException);
    });
  });

  // ── createRequest ──
  describe('createRequest', () => {
    it('devrait créer une demande plateforme avec un vendorId', async () => {
      const dto = { vendorId, source: VendorRequestSource.PLATFORM, message: 'Bonjour' };
      vendorRequestModel.create.mockResolvedValue(mockRequest());

      const result = await service.createRequest(eventId, userId, dto);

      expect(vendorRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ source: VendorRequestSource.PLATFORM, status: VendorRequestStatus.PENDING }),
      );
      expect(result).toBeDefined();
    });

    it('devrait créer une demande manuelle sans vendorId (source=manual)', async () => {
      const externalContact = { name: 'Jean Photo', email: 'jean@example.com' };
      const dto = { source: VendorRequestSource.MANUAL, externalContact };
      vendorRequestModel.create.mockResolvedValue(mockRequest({ vendor: undefined, source: VendorRequestSource.MANUAL }));

      const result = await service.createRequest(eventId, userId, dto);

      expect(vendorRequestModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ source: VendorRequestSource.MANUAL }),
      );
      expect(result).toBeDefined();
    });

    it('devrait notifier et envoyer un courriel au prestataire plateforme', async () => {
      const dto = { vendorId, source: VendorRequestSource.PLATFORM, message: 'Bonjour' };
      vendorRequestModel.create.mockResolvedValue(mockRequest());
      vendorModel.findById.mockReturnValue(
        makeChainable(mockVendor({ user: { toString: () => vendorUserId } })),
      );

      await service.createRequest(eventId, userId, dto);
      await flushAsync();

      expect(notificationsService.create).toHaveBeenCalledWith(
        vendorUserId,
        NotificationType.VENDOR_REQUEST_RECEIVED,
        expect.objectContaining({ requestId, eventTitle: 'Test Event' }),
      );
      expect(emailsService.sendNewRequest).toHaveBeenCalledWith(
        'org@test.com',
        expect.objectContaining({ vendorName: 'Photo Pro', eventTitle: 'Test Event' }),
      );
    });

    it('devrait envoyer un courriel au contact externe sans créer de notification', async () => {
      const externalContact = { name: 'Jean Photo', email: 'jean@example.com' };
      const dto = { source: VendorRequestSource.MANUAL, externalContact };
      vendorRequestModel.create.mockResolvedValue(mockRequest({ vendor: undefined, source: VendorRequestSource.MANUAL }));

      await service.createRequest(eventId, userId, dto);
      await flushAsync();

      expect(emailsService.sendNewRequest).toHaveBeenCalledWith(
        'jean@example.com',
        expect.objectContaining({ vendorName: 'Jean Photo' }),
      );
      expect(notificationsService.create).not.toHaveBeenCalled();
    });

    it('devrait ignorer l’envoi quand le contact externe n’a pas de courriel', async () => {
      const dto = { source: VendorRequestSource.MANUAL, externalContact: { name: 'Sans courriel' } };
      vendorRequestModel.create.mockResolvedValue(mockRequest({ vendor: undefined, source: VendorRequestSource.MANUAL }));

      await service.createRequest(eventId, userId, dto);
      await flushAsync();

      expect(emailsService.sendNewRequest).not.toHaveBeenCalled();
    });

    it('devrait retourner la demande même si le courriel échoue', async () => {
      const dto = { vendorId, source: VendorRequestSource.PLATFORM };
      vendorRequestModel.create.mockResolvedValue(mockRequest());
      emailsService.sendNewRequest.mockRejectedValueOnce(new Error('resend down'));

      await expect(service.createRequest(eventId, userId, dto)).resolves.toBeDefined();
      await flushAsync();
    });

    it('ne devrait ni notifier ni envoyer de courriel pour une demande en double', async () => {
      const dto = { vendorId, source: VendorRequestSource.PLATFORM };
      vendorRequestModel.findOne.mockReturnValue(makeChainable(mockRequest()));

      await service.createRequest(eventId, userId, dto);
      await flushAsync();

      expect(vendorRequestModel.create).not.toHaveBeenCalled();
      expect(emailsService.sendNewRequest).not.toHaveBeenCalled();
      expect(notificationsService.create).not.toHaveBeenCalled();
    });
  });

  // ── listRequestsByEvent ──
  describe('listRequestsByEvent', () => {
    it('devrait retourner les demandes pour un événement', async () => {
      const result = await service.listRequestsByEvent(eventId, userId);

      expect(vendorRequestModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ event: expect.any(Types.ObjectId) }),
      );
      expect(result).toHaveLength(1);
    });
  });

  // ── listMyRequests ──
  describe('listMyRequests', () => {
    it('devrait retourner les demandes du prestataire connecté', async () => {
      vendorModel.findOne.mockReturnValue(makeChainable({ _id: new Types.ObjectId(vendorId) }));

      const result = await service.listMyRequests(userId);

      expect(vendorRequestModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ vendor: expect.any(Types.ObjectId) }),
      );
      expect(result).toHaveLength(1);
    });

    it('devrait lever NotFoundException si le profil prestataire est introuvable', async () => {
      jest.spyOn(vendorModel, 'findOne').mockReturnValue({
        lean: () => ({ select: () => null }),
      } as any);

      await expect(service.listMyRequests(userId)).rejects.toThrow(NotFoundException);
    });
  });

  // ── respondToRequest ──
  // ── updateMyProfile (F-04) ──
  describe('updateMyProfile', () => {
    it('cible le profil du user connecté, jamais un id fourni par le client', async () => {
      vendorModel.findOneAndUpdate.mockReturnValue(makeChainable(mockVendor()));

      await service.updateMyProfile(userId, { businessName: 'Nouveau nom' });

      const [filter] = vendorModel.findOneAndUpdate.mock.calls[0] as [{ user: Types.ObjectId }];
      expect(filter.user.toString()).toBe(userId);
    });

    it('lève NotFoundException si aucun profil n’existe encore', async () => {
      // Le client doit pouvoir distinguer « pas de profil » (⇒ créer) d'une panne.
      vendorModel.findOneAndUpdate.mockReturnValue(makeChainable(null));

      await expect(service.updateMyProfile(userId, { businessName: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('applique les validateurs du schéma (catégorie hors énumération refusée)', async () => {
      vendorModel.findOneAndUpdate.mockReturnValue(makeChainable(mockVendor()));

      await service.updateMyProfile(userId, { businessName: 'X' });

      const [, , options] = vendorModel.findOneAndUpdate.mock.calls[0] as [
        unknown,
        unknown,
        { runValidators?: boolean },
      ];
      expect(options.runValidators).toBe(true);
    });
  });

  describe('respondToRequest', () => {
    const acceptDto = { status: VendorRequestStatus.ACCEPTED as VendorRequestStatus.ACCEPTED };
    const myProfile = () => makeChainable({ _id: new Types.ObjectId(vendorId), businessName: 'Lumière Nord' });

    it('devrait accepter une demande en attente via une transition conditionnelle', async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(
        makeChainable(mockRequest({ status: VendorRequestStatus.ACCEPTED })),
      );

      const result = await service.respondToRequest(requestId, userId, acceptDto);

      // L'état attendu est DANS le filtre : c'est ce qui empêche deux
      // réponses concurrentes de réussir toutes les deux.
      const [filter] = vendorRequestModel.findOneAndUpdate.mock.calls[0] as [
        { status: string; vendor: Types.ObjectId },
      ];
      expect(filter.status).toBe(VendorRequestStatus.PENDING);
      expect(filter.vendor.toString()).toBe(vendorId);
      expect(result).toBeDefined();
    });

    it('devrait enregistrer responseMessage et respondedAt', async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(makeChainable(mockRequest()));

      await service.respondToRequest(requestId, userId, {
        ...acceptDto,
        responseMessage: 'Avec plaisir',
      });

      const [, update] = vendorRequestModel.findOneAndUpdate.mock.calls[0] as [
        unknown,
        { responseMessage?: string; respondedAt?: Date },
      ];
      expect(update.responseMessage).toBe('Avec plaisir');
      expect(update.respondedAt).toBeInstanceOf(Date);
    });

    it("devrait lever NotFoundException si le prestataire n'a pas de profil", async () => {
      vendorModel.findOne.mockReturnValue(makeChainable(null));

      await expect(service.respondToRequest(requestId, userId, acceptDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('devrait lever ForbiddenException si la demande appartient à un autre prestataire', async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({
          vendor: new Types.ObjectId(),
          status: VendorRequestStatus.PENDING,
        }),
      );

      await expect(service.respondToRequest(requestId, userId, acceptDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("devrait lever ConflictException si la demande n'est plus en attente", async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({
          vendor: new Types.ObjectId(vendorId),
          status: VendorRequestStatus.ACCEPTED,
        }),
      );

      await expect(service.respondToRequest(requestId, userId, acceptDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('devrait lever NotFoundException si la demande a disparu', async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.respondToRequest(requestId, userId, acceptDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("devrait lever BadRequestException pour une demande manuelle sans prestataire plateforme", async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({ vendor: null, status: VendorRequestStatus.PENDING }),
      );

      await expect(service.respondToRequest(requestId, userId, acceptDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("n'émet AUCUN effet de bord lorsque la transition est perdue", async () => {
      // Avant ce correctif, deux réponses concurrentes envoyaient deux
      // notifications contradictoires pour la même demande.
      vendorModel.findOne.mockReturnValue(myProfile());
      vendorRequestModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({
          vendor: new Types.ObjectId(vendorId),
          status: VendorRequestStatus.ACCEPTED,
        }),
      );

      await expect(service.respondToRequest(requestId, userId, acceptDto)).rejects.toThrow(
        ConflictException,
      );
      expect(notificationsService.create).not.toHaveBeenCalled();
    });

    it('un seul de deux réponses concurrentes gagne', async () => {
      vendorModel.findOne.mockReturnValue(myProfile());
      // Le premier `findOneAndUpdate` matche `status: PENDING`, le second non.
      vendorRequestModel.findOneAndUpdate
        .mockReturnValueOnce(makeChainable(mockRequest({ status: VendorRequestStatus.ACCEPTED })))
        .mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({
          vendor: new Types.ObjectId(vendorId),
          status: VendorRequestStatus.ACCEPTED,
        }),
      );

      const outcomes = await Promise.allSettled([
        service.respondToRequest(requestId, userId, acceptDto),
        service.respondToRequest(requestId, userId, {
          status: VendorRequestStatus.DECLINED as VendorRequestStatus.DECLINED,
        }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(notificationsService.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── cancelRequest ──
  describe('cancelRequest', () => {
    it('devrait annuler une demande en attente via une suppression conditionnelle', async () => {
      vendorRequestModel.findOneAndDelete.mockReturnValue(makeChainable({ _id: requestId }));

      await service.cancelRequest(requestId, userId);

      const [filter] = vendorRequestModel.findOneAndDelete.mock.calls[0] as [
        { status: string; organizer: Types.ObjectId },
      ];
      expect(filter.status).toBe(VendorRequestStatus.PENDING);
      expect(filter.organizer.toString()).toBe(userId);
    });

    it("devrait lever ForbiddenException si l'organisateur ne correspond pas", async () => {
      vendorRequestModel.findOneAndDelete.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({
          organizer: { toString: () => new Types.ObjectId().toString() },
          status: VendorRequestStatus.PENDING,
        }),
      );

      await expect(service.cancelRequest(requestId, userId)).rejects.toThrow(ForbiddenException);
    });

    it('devrait lever NotFoundException si la demande est introuvable', async () => {
      vendorRequestModel.findOneAndDelete.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.cancelRequest(requestId, userId)).rejects.toThrow(NotFoundException);
    });

    it("devrait lever ConflictException si la demande a déjà été tranchée (course accept vs cancel)", async () => {
      vendorRequestModel.findOneAndDelete.mockReturnValue(makeChainable(null));
      vendorRequestModel.findById.mockReturnValue(
        makeChainable({
          organizer: { toString: () => userId },
          status: VendorRequestStatus.ACCEPTED,
        }),
      );

      await expect(service.cancelRequest(requestId, userId)).rejects.toThrow(ConflictException);
    });
  });

  describe('VendorRequest schema — source et externalContact (CDC v3)', () => {
    it('devrait avoir source à platform par défaut', () => {
      const path = VendorRequestSchema.path('source');
      expect(path).toBeDefined();
      expect((path as unknown as { defaultValue: string }).defaultValue).toBe('platform');
    });

    it('devrait avoir externalContact défini dans le schéma', () => {
      const path = VendorRequestSchema.path('externalContact');
      expect(path).toBeDefined();
    });
  });
  describe('projection publique', () => {
      it("n'expose pas l'identifiant du compte propriétaire dans le catalogue", async () => {
      // `user` est l'ObjectId interne du compte : il n'a rien à faire dans une
      // réponse anonyme, et les endpoints /discovery n'en exposaient déjà pas.
      vendorModel.find.mockReturnValue(makeChainable([mockVendor()]));

      await service.findAll({} as never);

      const projection = vendorModel.find.mock.results[0].value.select.mock.calls[0][0] as string;
      expect(projection).not.toContain('user');
      expect(projection).toContain('businessName');
    });

      it("n'expose pas l'identifiant du compte sur la fiche publique", async () => {
      vendorModel.findById.mockReturnValue(makeChainable(mockVendor()));

      await service.findOne('664f1a2b3c4d5e6f7a8b9c0d');

      const projection = vendorModel.findById.mock.results[0].value.select.mock.calls[0][0] as string;
      expect(projection).not.toContain('user');
    });
    });
});
