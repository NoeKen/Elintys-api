import { Test, TestingModule } from '@nestjs/testing';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockVenuesService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['organisateur'] };

describe('VenuesController', () => {
  let controller: VenuesController;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      controllers: [VenuesController],
      providers: [{ provide: VenuesService, useValue: mockVenuesService }],
    }).compile();

    controller = testingModule.get<VenuesController>(VenuesController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /venues ──
  describe('create', () => {
    it('délègue à venuesService.create avec user.sub et le DTO', async () => {
      const dto = { name: 'Salle des Étoiles', capacity: 500 };
      mockVenuesService.create.mockResolvedValue({ _id: 'venue-id', ...dto });

      await controller.create(mockUser as never, dto as never);

      expect(mockVenuesService.create).toHaveBeenCalledWith(mockUser.sub, dto);
    });
  });

  // ── GET /venues ──
  describe('findAll', () => {
    it('délègue à venuesService.findAll avec le DTO de requête', async () => {
      mockVenuesService.findAll.mockResolvedValue({ data: [], total: 0 });
      const query = {};

      await controller.findAll(query);

      expect(mockVenuesService.findAll).toHaveBeenCalledWith(query);
    });

    it('transmet les filtres validés', async () => {
      mockVenuesService.findAll.mockResolvedValue({ data: [], total: 0 });
      const query = { page: 2, limit: 5, city: 'Montréal', capacity: 200 };

      await controller.findAll(query);

      expect(mockVenuesService.findAll).toHaveBeenCalledWith(query);
    });
  });

  // ── GET /venues/:id ──
  describe('findOne', () => {
    it('délègue à venuesService.findOne avec l\'ID', async () => {
      mockVenuesService.findOne.mockResolvedValue({ _id: 'venue-id' });

      await controller.findOne('venue-id');

      expect(mockVenuesService.findOne).toHaveBeenCalledWith('venue-id');
    });
  });

  // ── PUT /venues/:id ──
  describe('update', () => {
    it('délègue à venuesService.update avec l\'ID, user.sub et le DTO', async () => {
      const dto = { name: 'Grande Salle' };
      mockVenuesService.update.mockResolvedValue({ _id: 'venue-id', ...dto });

      await controller.update('venue-id', mockUser as never, dto as never);

      expect(mockVenuesService.update).toHaveBeenCalledWith('venue-id', mockUser.sub, dto);
    });
  });
});
