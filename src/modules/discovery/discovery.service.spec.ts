import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { DiscoveryService } from './discovery.service';
import { Event, EventStatus, EventType, EventVisibility } from '../events/event.schema';
import { VendorCategory, VendorProfile } from '../vendors/vendor.schema';
import { VenueProfile, VenueType } from '../venues/venue.schema';
import { DiscoveryEntityType } from './dto/query-discovery.dto';
import { VendorPriceTier } from '../vendors/dto/query-vendor.dto';

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

describe('DiscoveryService', () => {
  let service: DiscoveryService;
  let eventModel: Record<string, jest.Mock>;
  let vendorModel: Record<string, jest.Mock>;
  let venueModel: Record<string, jest.Mock>;

  const mockPublicEvent = {
    _id: 'event-id',
    title: 'Gala de Montréal',
    status: EventStatus.PUBLISHED,
    visibility: EventVisibility.PUBLIC,
    startDate: new Date('2025-06-15'),
  };

  beforeEach(async () => {
    eventModel = { find: jest.fn(), countDocuments: jest.fn().mockResolvedValue(1) };
    vendorModel = { find: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) };
    venueModel = { find: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) };

    eventModel.find.mockReturnValue(makeChainable([mockPublicEvent]));
    vendorModel.find.mockReturnValue(makeChainable([]));
    venueModel.find.mockReturnValue(makeChainable([]));

    testingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
      ],
    }).compile();

    service = testingModule.get<DiscoveryService>(DiscoveryService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── search ──
  describe('search', () => {
    it('retourne des résultats combinés events, vendors et venues', async () => {
      const result = await service.search('gala', 1, 10);

      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('vendors');
      expect(result).toHaveProperty('venues');
      expect(result).toHaveProperty('totals', { events: 1, vendors: 0, venues: 0 });
      expect(result).toMatchObject({ page: 1, limit: 10 });
      expect(result.events).toHaveLength(1);
    });

    it('filtre les événements publiés sur discoverability public avec compatibilité legacy', async () => {
      await service.search('gala', 1, 10);

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            expect.objectContaining({
              status: EventStatus.PUBLISHED,
              archivedAt: null,
              $or: expect.any(Array),
            }),
          ]),
        }),
      );
    });

    it('filtre les prestataires sur isActive: true', async () => {
      await service.search('photo', 1, 10);

      expect(vendorModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
      );
    });

    it('retourne un tableau vide si aucun résultat trouvé', async () => {
      eventModel.find.mockReturnValue(makeChainable([]));
      vendorModel.find.mockReturnValue(makeChainable([]));
      venueModel.find.mockReturnValue(makeChainable([]));

      const result = await service.search('xyzzy-inexistant', 1, 10);

      expect(result.events).toHaveLength(0);
      expect(result.vendors).toHaveLength(0);
      expect(result.venues).toHaveLength(0);
    });

    it('exécute les trois requêtes en parallèle', async () => {
      await service.search('test', 1, 10);

      expect(eventModel.find).toHaveBeenCalledTimes(1);
      expect(vendorModel.find).toHaveBeenCalledTimes(1);
      expect(venueModel.find).toHaveBeenCalledTimes(1);
    });

    it('limite la recherche au type demandé sans interroger les autres collections', async () => {
      const result = await service.search('gala', 1, 10, DiscoveryEntityType.EVENT);

      expect(result.events).toHaveLength(1);
      expect(result.vendors).toEqual([]);
      expect(result.venues).toEqual([]);
      expect(vendorModel.find).not.toHaveBeenCalled();
      expect(venueModel.find).not.toHaveBeenCalled();
    });

    it('utilise les projections publiques riches sans champs privés', async () => {
      await service.search('gala', 1, 10);

      const eventChain = eventModel.find.mock.results[0].value as Record<string, jest.Mock>;
      const vendorChain = vendorModel.find.mock.results[0].value as Record<string, jest.Mock>;
      const venueChain = venueModel.find.mock.results[0].value as Record<string, jest.Mock>;
      expect(eventChain.select).toHaveBeenCalledWith(expect.stringContaining('coverImage'));
      expect(vendorChain.select).toHaveBeenCalledWith(expect.stringContaining('priceRange'));
      expect(venueChain.select).toHaveBeenCalledWith(expect.stringContaining('photos'));
      expect(eventChain.select).not.toHaveBeenCalledWith(expect.stringContaining('organizer'));
    });
  });

  // ── featuredEvents ──
  describe('featuredEvents', () => {
    it('retourne les événements publiés les plus récents', async () => {
      eventModel.find.mockReturnValue(makeChainable([mockPublicEvent]));

      const result = await service.featuredEvents(6);

      expect(result).toHaveLength(1);
      expect(eventModel.find).toHaveBeenCalledWith(expect.objectContaining({
        status: EventStatus.PUBLISHED,
        archivedAt: null,
        $or: expect.any(Array),
      }));
    });

    it('utilise la limite fournie', async () => {
      eventModel.find.mockReturnValue(makeChainable([]));

      await service.featuredEvents(3);

      const chain = eventModel.find.mock.results[0].value as Record<string, jest.Mock>;
      expect(chain.limit).toHaveBeenCalledWith(3);
    });
  });

  describe('typed catalogs', () => {
    it('applique type, ville et bornes UTC inclusives aux événements', async () => {
      await service.findEvents(
        'gala',
        'Montréal',
        EventType.GALA,
        '2027-05-01',
        '2027-05-31',
        2,
        12,
      );

      expect(eventModel.find).toHaveBeenCalledWith(expect.objectContaining({
        eventType: EventType.GALA,
        'location.city': expect.any(Object),
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              expect.objectContaining({ 'location.city': expect.any(Object) }),
            ]),
          }),
        ]),
        startDate: {
          $gte: new Date('2027-05-01T00:00:00.000Z'),
          $lte: new Date('2027-05-31T23:59:59.999Z'),
        },
      }));
    });

    it('applique catégorie, ville et palier de prix aux prestataires', async () => {
      await service.findVendors(
        'photo',
        VendorCategory.PHOTOGRAPHE,
        'Montréal',
        VendorPriceTier.STANDARD,
        1,
        12,
      );

      expect(vendorModel.find).toHaveBeenCalledWith(expect.objectContaining({
        isActive: true,
        category: VendorCategory.PHOTOGRAPHE,
        $or: expect.arrayContaining([
          expect.objectContaining({ serviceArea: expect.any(Object) }),
        ]),
        serviceArea: expect.any(Object),
        'priceRange.min': { $gt: 1000, $lte: 2500 },
      }));
    });

    it('applique type, ville et capacité minimale aux lieux', async () => {
      await service.findVenues('salle', 'Montréal', VenueType.RECEPTION, 200, 1, 12);

      expect(venueModel.find).toHaveBeenCalledWith(expect.objectContaining({
        isActive: true,
        type: VenueType.RECEPTION,
        $or: expect.arrayContaining([
          expect.objectContaining({ description: expect.any(Object) }),
        ]),
        'address.city': expect.any(Object),
        capacity: { $gte: 200 },
      }));
    });
  });
});
