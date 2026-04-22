import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

const mockDiscoveryService = {
  search: jest.fn(),
  featuredEvents: jest.fn(),
};

describe('DiscoveryController', () => {
  let controller: DiscoveryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiscoveryController],
      providers: [{ provide: DiscoveryService, useValue: mockDiscoveryService }],
    }).compile();

    controller = module.get<DiscoveryController>(DiscoveryController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── GET /discovery/search ──
  describe('search', () => {
    it('délègue à discoveryService.search avec les valeurs par défaut', async () => {
      mockDiscoveryService.search.mockResolvedValue({ events: [], vendors: [], venues: [] });

      await controller.search('gala', undefined, undefined);

      expect(mockDiscoveryService.search).toHaveBeenCalledWith('gala', 1, 10);
    });

    it('passe les valeurs de page et limit parsées', async () => {
      mockDiscoveryService.search.mockResolvedValue({ events: [], vendors: [], venues: [] });

      await controller.search('montréal', '2', '5');

      expect(mockDiscoveryService.search).toHaveBeenCalledWith('montréal', 2, 5);
    });

    it('utilise une chaîne vide si q est undefined', async () => {
      mockDiscoveryService.search.mockResolvedValue({ events: [], vendors: [], venues: [] });

      await controller.search(undefined as never, undefined, undefined);

      expect(mockDiscoveryService.search).toHaveBeenCalledWith('', 1, 10);
    });
  });

  // ── GET /discovery/featured ──
  describe('featured', () => {
    it('délègue à discoveryService.featuredEvents avec la limite par défaut', async () => {
      mockDiscoveryService.featuredEvents.mockResolvedValue([]);

      await controller.featured(undefined);

      expect(mockDiscoveryService.featuredEvents).toHaveBeenCalledWith(6);
    });

    it('passe la limite parsée', async () => {
      mockDiscoveryService.featuredEvents.mockResolvedValue([]);

      await controller.featured('3');

      expect(mockDiscoveryService.featuredEvents).toHaveBeenCalledWith(3);
    });
  });
});
