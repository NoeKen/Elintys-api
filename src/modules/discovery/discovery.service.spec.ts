import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { DiscoveryService } from './discovery.service';
import { Event, EventStatus, EventVisibility } from '../events/event.schema';
import { VendorProfile } from '../vendors/vendor.schema';
import { VenueProfile } from '../venues/venue.schema';

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
    eventModel = { find: jest.fn() };
    vendorModel = { find: jest.fn() };
    venueModel = { find: jest.fn() };

    eventModel.find.mockReturnValue(makeChainable([mockPublicEvent]));
    vendorModel.find.mockReturnValue(makeChainable([]));
    venueModel.find.mockReturnValue(makeChainable([]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(VendorProfile.name), useValue: vendorModel },
        { provide: getModelToken(VenueProfile.name), useValue: venueModel },
      ],
    }).compile();

    service = module.get<DiscoveryService>(DiscoveryService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── search ──
  describe('search', () => {
    it('retourne des résultats combinés events, vendors et venues', async () => {
      const result = await service.search('gala', 1, 10);

      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('vendors');
      expect(result).toHaveProperty('venues');
      expect(result.events).toHaveLength(1);
    });

    it('filtre les événements sur status published et visibility public', async () => {
      await service.search('gala', 1, 10);

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EventStatus.PUBLISHED,
          visibility: EventVisibility.PUBLIC,
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
  });

  // ── featuredEvents ──
  describe('featuredEvents', () => {
    it('retourne les événements publiés les plus récents', async () => {
      eventModel.find.mockReturnValue(makeChainable([mockPublicEvent]));

      const result = await service.featuredEvents(6);

      expect(result).toHaveLength(1);
      expect(eventModel.find).toHaveBeenCalledWith({
        status: EventStatus.PUBLISHED,
        visibility: EventVisibility.PUBLIC,
      });
    });

    it('utilise la limite fournie', async () => {
      eventModel.find.mockReturnValue(makeChainable([]));

      await service.featuredEvents(3);

      const chain = eventModel.find.mock.results[0].value as Record<string, jest.Mock>;
      expect(chain.limit).toHaveBeenCalledWith(3);
    });
  });
});
