import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InvitationsService } from './invitations.service';
import { Invitation, InvitationType } from './invitation.schema';
import { ErrorCodes } from '../../shared/constants/error-codes';

const mockInvitationModel = {
  create: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
};

const mockInvitedById = new Types.ObjectId().toString();

describe('InvitationsService', () => {
  let service: InvitationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: getModelToken(Invitation.name), useValue: mockInvitationModel },
      ],
    }).compile();
    service = module.get<InvitationsService>(InvitationsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('devrait être défini', () => {
    expect(service).toBeDefined();
  });

  describe('sendInvitation', () => {
    it('devrait créer une invitation avec les champs corrects', async () => {
      const mockInvitation = {
        _id: new Types.ObjectId(),
        email: 'test@example.com',
        name: 'Test User',
        type: InvitationType.VENDOR,
        status: 'pending',
      };
      mockInvitationModel.create.mockResolvedValueOnce(mockInvitation);

      const result = await service.sendInvitation(mockInvitedById, {
        email: 'test@example.com',
        name: 'Test User',
        type: InvitationType.VENDOR,
      });

      expect(mockInvitationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          invitedBy: expect.any(Types.ObjectId),
          email: 'test@example.com',
          name: 'Test User',
          type: InvitationType.VENDOR,
        }),
      );
      expect(result).toEqual(mockInvitation);
    });

    it('devrait lancer ConflictException si invitation déjà envoyée', async () => {
      mockInvitationModel.create.mockRejectedValueOnce({ code: 11000 });

      await expect(
        service.sendInvitation(mockInvitedById, {
          email: 'dup@example.com',
          name: 'Dup User',
          type: InvitationType.VENDOR,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('acceptInvitation', () => {
    it('devrait lancer NotFoundException si token invalide', async () => {
      mockInvitationModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValueOnce(null),
      });

      await expect(service.acceptInvitation('bad-token')).rejects.toThrow(NotFoundException);
    });

    it('devrait mettre à jour le statut à accepted', async () => {
      const mockInvitation = {
        _id: new Types.ObjectId(),
        token: 'valid-token',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86400000),
        save: jest.fn().mockResolvedValueOnce({
          status: 'accepted',
          acceptedAt: new Date(),
        }),
      };
      mockInvitationModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValueOnce(mockInvitation),
      });

      const result = await service.acceptInvitation('valid-token');
      expect(mockInvitation.save).toHaveBeenCalled();
    });
  });

  describe('getMyInvitations', () => {
    it("devrait retourner les invitations de l'utilisateur", async () => {
      const mockInvitations = [{ email: 'a@b.com' }, { email: 'c@d.com' }];
      mockInvitationModel.find.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValueOnce(mockInvitations),
      });

      const result = await service.getMyInvitations(mockInvitedById);
      expect(result).toHaveLength(2);
    });
  });
});
