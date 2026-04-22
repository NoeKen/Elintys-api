import { Test, TestingModule } from '@nestjs/testing';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

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
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VenuesController],
      providers: [{ provide: VenuesService, useValue: mockVenuesService }],
    }).compile();

    controller = module.get<VenuesController>(VenuesController);
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
    it('délègue à venuesService.findAll avec page et limit par défaut', async () => {
      mockVenuesService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(undefined, undefined);

      expect(mockVenuesService.findAll).toHaveBeenCalledWith(1, 20);
    });

    it('passe les valeurs de page et limit parsées', async () => {
      mockVenuesService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll('2', '5');

      expect(mockVenuesService.findAll).toHaveBeenCalledWith(2, 5);
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
