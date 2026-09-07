import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ClientSession, Types } from 'mongoose';
import { TicketsService } from './tickets.service';
import { TicketType, TicketPurchase, TicketPurchaseStatus, TicketPurchaseSchema } from './ticket.schema';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { Event } from '../events/event.schema';
import { EventAccessService } from '../events/event-access.service';
import { IdempotencyService } from '../../shared/consistency/idempotency/idempotency.service';
import { InsufficientCapacityError } from '../../shared/consistency/errors/consistency.errors';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
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

describe('TicketsService', () => {
  let service: TicketsService;
  let ticketTypeModel: Record<string, jest.Mock>;
  let ticketPurchaseModel: Record<string, jest.Mock>;
  let eventModel: Record<string, jest.Mock>;
  let idempotencyService: { execute: jest.Mock };

  const mockSession = {} as ClientSession;

  const idempotencyPassthrough = (execute: jest.Mock) => {
    execute.mockImplementation(
      async (params: { operation: (s: ClientSession) => Promise<unknown> }) =>
        params.operation(mockSession),
    );
  };

  const organizerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const ticketTypeId = new Types.ObjectId().toString();
  const buyerId = new Types.ObjectId().toString();

  const mockEvent = (overrides = {}) => ({
    _id: eventId,
    organizer: { toString: () => organizerId },
    status: 'published',
    discoverability: 'public',
    accessPolicy: { type: 'open' },
    admissionModes: ['free_ticket', 'paid_ticket'],
    ...overrides,
  });

  const mockTicketType = (overrides = {}) => ({
    _id: ticketTypeId,
    name: 'VIP',
    price: 150,
    quantity: 100,
    sold: 0,
    reserved: 0,
    isFree: false,
    event: { toString: () => eventId },
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  const mockPurchase = (overrides = {}) => ({
    _id: new Types.ObjectId(),
    qrCode: 'ABCD-EFGH-IJKL',
    status: TicketPurchaseStatus.VALID,
    event: { toString: () => eventId },
    ticketType: { toString: () => ticketTypeId },
    price: 0,
    scannedAt: undefined,
    toObject: jest.fn().mockReturnThis(),
    ...overrides,
  });

  beforeEach(async () => {
    ticketTypeModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      create: jest.fn(),
    };

    ticketPurchaseModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    };

    eventModel = {
      findById: jest.fn(),
    };

    idempotencyService = { execute: jest.fn() };
    idempotencyPassthrough(idempotencyService.execute);

    eventModel.findById.mockReturnValue(makeChainable(mockEvent()));
    ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType()));
    ticketTypeModel.find.mockReturnValue(makeChainable([mockTicketType()]));
    ticketTypeModel.findOneAndUpdate.mockReturnValue(makeChainable(mockTicketType()));
    ticketTypeModel.findOneAndDelete.mockResolvedValue(mockTicketType());

    testingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: getModelToken(TicketType.name), useValue: ticketTypeModel },
        { provide: getModelToken(TicketPurchase.name), useValue: ticketPurchaseModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: EventAccessService, useValue: { buildActor: jest.fn().mockResolvedValue({ userId: buyerId }) } },
        { provide: IdempotencyService, useValue: idempotencyService },
      ],
    }).compile();

    service = testingModule.get<TicketsService>(TicketsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createTicketType ──
  describe('createTicketType', () => {
    it("crée un type de billet pour l'événement", async () => {
      const dto = { name: 'VIP', price: 150, quantity: 100 };
      const tt = mockTicketType(dto);
      ticketTypeModel.create.mockResolvedValue(tt);

      const result = await service.createTicketType(eventId, organizerId, dto as never);

      expect(ticketTypeModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'VIP' }),
      );
      expect(result).toBeDefined();
    });

    it("lève ForbiddenException si l'utilisateur n'est pas l'organisateur", async () => {
      await expect(
        service.createTicketType(eventId, 'autre-user-id', { name: 'VIP' } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it("lève NotFoundException si l'événement n'existe pas", async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(
        service.createTicketType('id-inexistant', organizerId, { name: 'VIP' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuse un billet payant sans prix strictement positif', async () => {
      await expect(
        service.createTicketType(eventId, organizerId, {
          name: 'VIP',
          isFree: false,
          price: 0,
          quantity: 10,
        } as never),
      ).rejects.toThrow('PAID_TICKET_PRICE_REQUIRED');
      expect(ticketTypeModel.create).not.toHaveBeenCalled();
    });
  });

  // ── findTicketTypes ──
  describe('findTicketTypes', () => {
    it("retourne les types de billets pour l'événement", async () => {
      const result = await service.findTicketTypes(eventId);

      expect(result).toHaveLength(1);
      expect(ticketTypeModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ event: expect.any(Types.ObjectId) }),
      );
    });

    it.each([
      ['privé', { discoverability: 'private' }],
      ['archivé', { archivedAt: new Date() }],
      ['brouillon', { status: 'draft' }],
    ])('ne projette aucun billet pour un événement %s', async (_label, overrides) => {
      eventModel.findById.mockReturnValue(makeChainable(mockEvent(overrides)));

      await expect(service.findTicketTypes(eventId)).rejects.toThrow(NotFoundException);
      expect(ticketTypeModel.find).not.toHaveBeenCalled();
    });
  });

  describe('findManagedTicketTypes', () => {
    it('retourne les types de billets au propriétaire même pour un brouillon', async () => {
      eventModel.findById.mockReturnValue(makeChainable(mockEvent({ status: 'draft' })));

      const result = await service.findManagedTicketTypes(eventId, organizerId);

      expect(result).toHaveLength(1);
      expect(ticketTypeModel.find).toHaveBeenCalledWith({ event: expect.any(Types.ObjectId) });
    });

    it('refuse un autre organisateur', async () => {
      await expect(service.findManagedTicketTypes(eventId, 'autre-user-id')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── updateTicketType ──
  describe('updateTicketType', () => {
    it('met à jour et retourne le type de billet', async () => {
      const dto = { name: 'VIP Platinum' };
      const updated = mockTicketType(dto);
      ticketTypeModel.findOneAndUpdate.mockReturnValue(makeChainable(updated));

      const result = await service.updateTicketType(ticketTypeId, organizerId, dto as never);

      expect(result.name).toBe('VIP Platinum');
    });

    it("lève NotFoundException si le type de billet n'existe pas", async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(null));

      await expect(
        service.updateTicketType('id-inexistant', organizerId, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si l'utilisateur n'est pas l'organisateur", async () => {
      await expect(
        service.updateTicketType(ticketTypeId, 'autre-user-id', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuse de réduire la capacité sous le nombre déjà vendu', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType({ sold: 8 })));

      await expect(
        service.updateTicketType(ticketTypeId, organizerId, { quantity: 7 }),
      ).rejects.toThrow('TICKET_QUANTITY_BELOW_SOLD');
      expect(ticketTypeModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuse de réduire la capacité sous le stock réservé', async () => {
      ticketTypeModel.findById.mockReturnValue(
        makeChainable(mockTicketType({ sold: 2, reserved: 6 })),
      );

      await expect(
        service.updateTicketType(ticketTypeId, organizerId, { quantity: 7 }),
      ).rejects.toThrow('TICKET_QUANTITY_BELOW_SOLD');
      expect(ticketTypeModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('ferme la race entre validation et mise à jour de capacité', async () => {
      ticketTypeModel.findOneAndUpdate.mockReturnValue(makeChainable(null));

      await expect(
        service.updateTicketType(ticketTypeId, organizerId, { quantity: 10 }),
      ).rejects.toThrow('TICKET_QUANTITY_BELOW_SOLD');
      expect(ticketTypeModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ $expr: expect.any(Object) }),
        expect.objectContaining({ quantity: 10 }),
        expect.objectContaining({ new: true, runValidators: true }),
      );
    });
  });

  // ── removeTicketType ──
  describe('removeTicketType', () => {
    it('supprime le type de billet', async () => {
      await expect(service.removeTicketType(ticketTypeId, organizerId)).resolves.toBeUndefined();
      expect(ticketTypeModel.findOneAndDelete).toHaveBeenCalledWith(
        expect.objectContaining({ $expr: expect.any(Object) }),
      );
    });

    it("lève NotFoundException si le type de billet n'existe pas", async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.removeTicketType('id-inexistant', organizerId)).rejects.toThrow(NotFoundException);
    });

    it("lève ForbiddenException si l'utilisateur n'est pas l'organisateur", async () => {
      await expect(service.removeTicketType(ticketTypeId, 'autre-user-id')).rejects.toThrow(ForbiddenException);
    });

    it('refuse de supprimer un type de billet ayant déjà des ventes', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType({ sold: 1 })));

      await expect(service.removeTicketType(ticketTypeId, organizerId)).rejects.toThrow(
        'TICKET_TYPE_HAS_SALES',
      );
      expect(ticketTypeModel.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('refuse de supprimer un type ayant une réservation active', async () => {
      ticketTypeModel.findById.mockReturnValue(
        makeChainable(mockTicketType({ sold: 0, reserved: 1 })),
      );

      await expect(service.removeTicketType(ticketTypeId, organizerId)).rejects.toThrow(
        'TICKET_TYPE_HAS_SALES',
      );
      expect(ticketTypeModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('refuse la suppression si une réservation gagne la course après la lecture', async () => {
      ticketTypeModel.findOneAndDelete.mockResolvedValue(null);

      await expect(service.removeTicketType(ticketTypeId, organizerId)).rejects.toThrow(
        'TICKET_TYPE_HAS_SALES',
      );
    });
  });

  // ── findMyTickets ──
  describe('findMyTickets', () => {
    it("retourne les billets de l'acheteur", async () => {
      ticketPurchaseModel.find.mockReturnValue(makeChainable([{ _id: 'ticket-1' }]));

      const result = await service.findMyTickets(buyerId);

      expect(result).toHaveLength(1);
      expect(ticketPurchaseModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ buyerId: expect.any(Types.ObjectId) }),
      );
    });
  });

  // ── purchase ──
  describe('purchase', () => {
    const IDEM_KEY = 'test-idempotency-key-abc';
    const dto = { ticketTypeId, quantity: 2, guestEmail: undefined };
    const freeTT = mockTicketType({ isFree: true, quantity: 10, sold: 0, price: 0 });

    it('réserve le stock atomiquement et crée les billets séquentiellement', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(freeTT));
      ticketTypeModel.findOneAndUpdate.mockResolvedValue(freeTT);
      const purchase = mockPurchase();
      ticketPurchaseModel.create.mockResolvedValue([purchase]);

      const result = await service.purchase(buyerId, dto as never, IDEM_KEY);

      // Réservation atomique dans la transaction
      expect(ticketTypeModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: expect.any(Types.ObjectId),
          $expr: expect.objectContaining({ $lte: expect.any(Array) }),
        }),
        { $inc: { sold: 2 } },
        expect.objectContaining({ new: true, session: mockSession }),
      );
      // Création séquentielle — une fois par billet
      expect(ticketPurchaseModel.create).toHaveBeenCalledTimes(2);
      expect(ticketPurchaseModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ status: TicketPurchaseStatus.VALID })],
        { session: mockSession },
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expect.objectContaining({
        event: eventId,
        ticketType: ticketTypeId,
        price: 0,
        status: TicketPurchaseStatus.VALID,
      }));
    });

    it('passe scope, actorId et idempotencyKey à IdempotencyService', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(freeTT));
      ticketTypeModel.findOneAndUpdate.mockResolvedValue(freeTT);
      ticketPurchaseModel.create.mockResolvedValue([mockPurchase()]);

      await service.purchase(buyerId, dto as never, IDEM_KEY);

      expect(idempotencyService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'ticket-purchase',
          actorId: buyerId,
          idempotencyKey: IDEM_KEY,
          payload: { ticketTypeId, quantity: 2 },
        }),
      );
    });

    it('lève InsufficientCapacityError si la réservation atomique échoue (race condition)', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(freeTT));
      ticketTypeModel.findOneAndUpdate.mockResolvedValue(null); // DB guard catches race

      await expect(service.purchase(buyerId, dto as never, IDEM_KEY))
        .rejects.toBeInstanceOf(InsufficientCapacityError);
      expect(ticketPurchaseModel.create).not.toHaveBeenCalled();
    });

    it('inclut le stock réservé par une commande payante dans le garde de capacité', async () => {
      ticketTypeModel.findById.mockReturnValue(
        makeChainable(mockTicketType({ isFree: true, quantity: 10, sold: 4, reserved: 5 })),
      );
      ticketTypeModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.purchase(buyerId, dto as never, IDEM_KEY)).rejects.toBeInstanceOf(
        InsufficientCapacityError,
      );
      expect(ticketTypeModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ $expr: expect.objectContaining({ $lte: expect.any(Array) }) }),
        { $inc: { sold: 2 } },
        expect.objectContaining({ session: mockSession }),
      );
    });

    it('lève BadRequestException si le billet est payant', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(mockTicketType({ isFree: false })));

      await expect(service.purchase(buyerId, dto as never, IDEM_KEY)).rejects.toThrow(BadRequestException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it('lève InsufficientCapacityError si le stock est insuffisant (vérification applicative)', async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(
        mockTicketType({ isFree: true, quantity: 1, sold: 1 }),
      ));
      ticketTypeModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.purchase(buyerId, { ...dto, quantity: 2 } as never, IDEM_KEY))
        .rejects.toBeInstanceOf(InsufficientCapacityError);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });

    it("lève NotFoundException si le type de billet n'existe pas", async () => {
      ticketTypeModel.findById.mockReturnValue(makeChainable(null));

      await expect(service.purchase(buyerId, dto as never, IDEM_KEY)).rejects.toThrow(NotFoundException);
      expect(idempotencyService.execute).toHaveBeenCalled();
    });
  });

  // ── scan ──
  describe('scan', () => {
    // La transition est conditionnelle : `findOneAndUpdate` ne retourne un
    // document QUE si le billet était VALID et rattaché à cet événement.
    const admitOnce = () => {
      ticketPurchaseModel.findOneAndUpdate.mockReturnValueOnce(makeChainable(mockPurchase()));
      ticketPurchaseModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
    };
    const admitNever = () => {
      ticketPurchaseModel.findOneAndUpdate.mockReturnValue(makeChainable(null));
    };

    it('admet un billet valide de cet événement et le marque utilisé atomiquement', async () => {
      admitOnce();

      const result = await service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']);

      // Le filtre porte l'état attendu : c'est ce qui rend la transition sûre.
      expect(ticketPurchaseModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          qrCode: 'ABCD-EFGH-IJKL',
          status: TicketPurchaseStatus.VALID,
        }),
        expect.objectContaining({ status: TicketPurchaseStatus.USED }),
        expect.objectContaining({ new: true }),
      );
      expect(result.outcome).toBe('admitted');
    });

    it('trace le compte qui a scanné', async () => {
      admitOnce();

      await service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']);

      const [, update] = ticketPurchaseModel.findOneAndUpdate.mock.calls[0] as [
        unknown,
        { scannedBy?: Types.ObjectId; scannedAt?: Date },
      ];
      expect(update.scannedBy?.toString()).toBe(organizerId);
      expect(update.scannedAt).toBeInstanceOf(Date);
    });

    it('lie le billet à l\'événement scanné', async () => {
      admitOnce();

      await service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']);

      const [filter] = ticketPurchaseModel.findOneAndUpdate.mock.calls[0] as [
        { event?: Types.ObjectId },
      ];
      expect(filter.event?.toString()).toBe(eventId);
    });

    it('retourne already_used sans réécrire quand le billet a déjà été scanné', async () => {
      admitNever();
      ticketPurchaseModel.findOne.mockReturnValue(
        makeChainable(mockPurchase({ status: TicketPurchaseStatus.USED, scannedAt: new Date() })),
      );

      const result = await service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']);

      expect(result.outcome).toBe('already_used');
      expect(result.message).toContain('déjà utilisé');
    });

    it('lève BadRequestException pour un billet annulé', async () => {
      admitNever();
      ticketPurchaseModel.findOne.mockReturnValue(
        makeChainable(mockPurchase({ status: TicketPurchaseStatus.CANCELLED })),
      );

      await expect(
        service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']),
      ).rejects.toThrow(BadRequestException);
    });

    it('lève NotFoundException si le code QR est inconnu pour cet événement', async () => {
      admitNever();
      ticketPurchaseModel.findOne.mockReturnValue(makeChainable(null));

      await expect(
        service.scan(eventId, 'XXXX-YYYY-ZZZZ', organizerId, ['organisateur']),
      ).rejects.toThrow(NotFoundException);
    });

    it("refuse un billet appartenant à un AUTRE événement, sans révéler son existence", async () => {
      // La transition ne matche pas (mauvais `event`) et la relecture est elle
      // aussi restreinte à l'événement autorisé : le billet reste invisible.
      admitNever();
      ticketPurchaseModel.findOne.mockReturnValue(makeChainable(null));

      await expect(
        service.scan(eventId, 'BILLET-EVENEMENT-B', organizerId, ['organisateur']),
      ).rejects.toThrow(NotFoundException);
      const [filter] = ticketPurchaseModel.findOne.mock.calls[0] as [{ event?: Types.ObjectId }];
      expect(filter.event?.toString()).toBe(eventId);
    });

    it("lève ForbiddenException si le scanneur ne gère pas cet événement", async () => {
      await expect(
        service.scan(eventId, 'ABCD-EFGH-IJKL', 'autre-organizer', ['organisateur']),
      ).rejects.toThrow(ForbiddenException);
      // Autorisation AVANT lecture : aucune sonde possible sur le code QR.
      expect(ticketPurchaseModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(ticketPurchaseModel.findOne).not.toHaveBeenCalled();
    });

    it('autorise un admin sur un événement dont il n\'est pas propriétaire', async () => {
      admitOnce();
      const adminId = new Types.ObjectId().toString();

      const result = await service.scan(eventId, 'ABCD-EFGH-IJKL', adminId, ['admin']);

      expect(result.outcome).toBe('admitted');
    });

    it("lève NotFoundException si l'événement scanné n'existe pas", async () => {
      eventModel.findById.mockReturnValue(makeChainable(null));

      await expect(
        service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']),
      ).rejects.toThrow(NotFoundException);
    });

    it('un seul de deux scans concurrents est admis', async () => {
      // Modélise la garantie du `findOneAndUpdate` conditionnel : le premier
      // appel matche `status: VALID`, le second ne matche plus rien.
      admitOnce();
      ticketPurchaseModel.findOne.mockReturnValue(
        makeChainable(mockPurchase({ status: TicketPurchaseStatus.USED, scannedAt: new Date() })),
      );

      const results = await Promise.all([
        service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']),
        service.scan(eventId, 'ABCD-EFGH-IJKL', organizerId, ['organisateur']),
      ]);

      expect(results.filter((r) => r.outcome === 'admitted')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'already_used')).toHaveLength(1);
    });
  });

  // ── purchase — identité authentifiée ──
  describe('purchase — identité authentifiée', () => {
    it('devrait avoir guestName dans le schéma TicketPurchase', () => {
      const guestNamePath = TicketPurchaseSchema.path('guestName');
      expect(guestNamePath).toBeDefined();
    });

    it('devrait lever BadRequestException si buyerId est null et guestEmail absent', async () => {
      const freeTT = mockTicketType({ isFree: true, quantity: 10, sold: 0, price: 0 });
      ticketTypeModel.findById.mockReturnValue(makeChainable(freeTT));

      await expect(
        service.purchase(null as unknown as string, { ticketTypeId, quantity: 1 } as PurchaseTicketDto, 'key'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── linkGuestPurchases ──
  describe('linkGuestPurchases', () => {
    it("rattache les achats invité à l'utilisateur nouvellement inscrit", async () => {
      ticketPurchaseModel.updateMany.mockResolvedValue({ modifiedCount: 2 });

      await expect(
        service.linkGuestPurchases('marie@exemple.ca', buyerId),
      ).resolves.toBeUndefined();

      expect(ticketPurchaseModel.updateMany).toHaveBeenCalledWith(
        { guestEmail: 'marie@exemple.ca', buyerId: null },
        { buyerId: expect.any(Types.ObjectId) },
      );
    });
  });
});
