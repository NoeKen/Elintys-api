import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockDiscoveryService = {
  search: jest.fn(),
  featuredEvents: jest.fn(),
};

describe('DiscoveryController', () => {
  let controller: DiscoveryController;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      controllers: [DiscoveryController],
      providers: [{ provide: DiscoveryService, useValue: mockDiscoveryService }],
    }).compile();

    controller = testingModule.get<DiscoveryController>(DiscoveryController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── GET /discovery/search ──
  describe('search', () => {
    it('délègue le DTO validé au service', async () => {
      mockDiscoveryService.search.mockResolvedValue({ events: [], vendors: [], venues: [] });

      await controller.search({ q: 'gala', page: 1, limit: 10 });

      expect(mockDiscoveryService.search).toHaveBeenCalledWith('gala', 1, 10);
    });

    it('transmet la pagination demandée', async () => {
      mockDiscoveryService.search.mockResolvedValue({ events: [], vendors: [], venues: [] });

      await controller.search({ q: 'montréal', page: 2, limit: 5 });

      expect(mockDiscoveryService.search).toHaveBeenCalledWith('montréal', 2, 5);
    });
  });

  // ── GET /discovery/featured ──
  describe('featured', () => {
    it('délègue la limite validée', async () => {
      mockDiscoveryService.featuredEvents.mockResolvedValue([]);

      await controller.featured({ limit: 6 });

      expect(mockDiscoveryService.featuredEvents).toHaveBeenCalledWith(6);
    });

    it('transmet une limite explicite', async () => {
      mockDiscoveryService.featuredEvents.mockResolvedValue([]);

      await controller.featured({ limit: 3 });

      expect(mockDiscoveryService.featuredEvents).toHaveBeenCalledWith(3);
    });
  });
});
