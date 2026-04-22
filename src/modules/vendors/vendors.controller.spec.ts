import { Test, TestingModule } from '@nestjs/testing';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';

const mockVendorsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  findMyProfile: jest.fn(),
  update: jest.fn(),
};

const mockUser = { sub: 'user-id-123', email: 'jean@test.com', roles: ['prestataire'] };

describe('VendorsController', () => {
  let controller: VendorsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VendorsController],
      providers: [{ provide: VendorsService, useValue: mockVendorsService }],
    }).compile();

    controller = module.get<VendorsController>(VendorsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /vendors ──
  describe('create', () => {
    it('délègue à vendorsService.create avec user.sub et le DTO', async () => {
      const dto = { businessName: 'Photo Pro', category: 'photographe' };
      mockVendorsService.create.mockResolvedValue({ _id: 'vendor-id', ...dto });

      await controller.create(mockUser as never, dto as never);

      expect(mockVendorsService.create).toHaveBeenCalledWith(mockUser.sub, dto);
    });
  });

  // ── GET /vendors ──
  describe('findAll', () => {
    it('délègue à vendorsService.findAll avec les query params', async () => {
      const query = { page: 1, limit: 20 };
      mockVendorsService.findAll.mockResolvedValue({ data: [], total: 0 });

      await controller.findAll(query as never);

      expect(mockVendorsService.findAll).toHaveBeenCalledWith(query);
    });
  });

  // ── GET /vendors/me ──
  describe('myProfile', () => {
    it('délègue à vendorsService.findMyProfile avec user.sub', async () => {
      mockVendorsService.findMyProfile.mockResolvedValue({ _id: 'vendor-id' });

      await controller.myProfile(mockUser as never);

      expect(mockVendorsService.findMyProfile).toHaveBeenCalledWith(mockUser.sub);
    });
  });

  // ── GET /vendors/:id ──
  describe('findOne', () => {
    it('délègue à vendorsService.findOne avec l\'ID', async () => {
      mockVendorsService.findOne.mockResolvedValue({ _id: 'vendor-id' });

      await controller.findOne('vendor-id');

      expect(mockVendorsService.findOne).toHaveBeenCalledWith('vendor-id');
    });
  });

  // ── PUT /vendors/:id ──
  describe('update', () => {
    it('délègue à vendorsService.update avec l\'ID, user.sub et le DTO', async () => {
      const dto = { businessName: 'Photo Pro Elite' };
      mockVendorsService.update.mockResolvedValue({ _id: 'vendor-id', ...dto });

      await controller.update('vendor-id', mockUser as never, dto as never);

      expect(mockVendorsService.update).toHaveBeenCalledWith('vendor-id', mockUser.sub, dto);
    });
  });
});
