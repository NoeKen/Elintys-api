import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { InvitationsService } from './invitations.service';
import { Invitation, InvitationType } from './invitation.schema';
import { EmailsService } from '../emails/emails.service';
import { User } from '../auth/user.schema';
import { Event } from '../events/event.schema';
import { NotificationsService } from '../notifications/notifications.service';

let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockInvitationModel = {
  create: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOneAndUpdate: jest.fn(),
};

describe('InvitationsService.findByEvent', () => {
  let service: InvitationsService;
  const eventModel = { findById: jest.fn() };

  const ownerAId = new Types.ObjectId().toString();
  const userBId = new Types.ObjectId().toString();
  const eventAId = new Types.ObjectId().toString();

  beforeEach(async () => {
    mockInvitationModel.countDocuments.mockResolvedValue(0);
    testingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        {
          provide: getModelToken(Invitation.name),
          useValue: mockInvitationModel,
        },
        {
          provide: getModelToken(User.name),
          useValue: {
            findById: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnThis(),
              select: jest.fn().mockResolvedValue({ fullName: 'Test User' }),
            }),
          },
        },
        { provide: getModelToken(Event.name), useValue: eventModel },
        {
          provide: EmailsService,
          useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = testingModule.get<InvitationsService>(InvitationsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('devrait être défini', () => {
    expect(service).toBeDefined();
  });

  describe('owner A gets invitations for event A → 200 with OrganizerInvitationDto[]', () => {
    it('devrait retourner la liste des invitations pour l\'organisateur propriétaire', async () => {
      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventAId),
          organizer: { toString: () => ownerAId },
        }),
      });

      const now = new Date();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const mockInvitations = [
        {
          _id: new Types.ObjectId(),
          email: 'participant1@example.com',
          name: 'Participant Un',
          type: InvitationType.PARTICIPANT,
          status: 'pending',
          maxUses: 1,
          useCount: 0,
          expiresAt: expires,
          createdAt: now,
        },
        {
          _id: new Types.ObjectId(),
          email: 'participant2@example.com',
          name: 'Participant Deux',
          type: InvitationType.PARTICIPANT,
          status: 'accepted',
          maxUses: 1,
          useCount: 1,
          expiresAt: expires,
          createdAt: now,
        },
      ];

      mockInvitationModel.find.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(mockInvitations),
      });

      mockInvitationModel.countDocuments.mockResolvedValue(2);
      const result = await service.findByEvent(eventAId, ownerAId);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.data[0].email).toBe('participant1@example.com');
      expect(result.data[0].name).toBe('Participant Un');
      expect(result.data[0].type).toBe(InvitationType.PARTICIPANT);
      expect(result.data[0].status).toBe('pending');
      expect(result.data[0]).not.toHaveProperty('tokenPrefix');
      expect(result.data[0]._id).toBeDefined();
      expect(result.data[0].expiresAt).toBeDefined();
      expect(result.data[0].createdAt).toBeDefined();

      // Verify query was called with correct filter
      expect(mockInvitationModel.find).toHaveBeenCalledWith({
        eventId: expect.any(Types.ObjectId),
        type: InvitationType.PARTICIPANT,
      });
    });

    it('ne devrait jamais contenir tokenHash ou token dans la réponse', async () => {
      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventAId),
          organizer: { toString: () => ownerAId },
        }),
      });

      const mockInvitations = [
        {
          _id: new Types.ObjectId(),
          email: 'secure@example.com',
          name: 'Secure User',
          type: InvitationType.PARTICIPANT,
          status: 'pending',
          tokenPrefix: 'safe1234',
          tokenHash: 'should-never-appear-in-response',
          token: 'raw-token-secret',
          maxUses: 1,
          useCount: 0,
          expiresAt: new Date(),
          createdAt: new Date(),
        },
      ];

      mockInvitationModel.find.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(mockInvitations),
      });

      const result = await service.findByEvent(eventAId, ownerAId);
      const serialized = JSON.stringify(result);

      expect(result.data[0]).not.toHaveProperty('tokenHash');
      expect(result.data[0]).not.toHaveProperty('token');
      expect(result.data[0]).not.toHaveProperty('tokenPrefix');
      expect(serialized).not.toContain('should-never-appear-in-response');
      expect(serialized).not.toContain('raw-token-secret');
    });
  });

  describe('non-owner B → ForbiddenException', () => {
    it('devrait lancer ForbiddenException si l\'utilisateur n\'est pas propriétaire de l\'événement', async () => {
      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventAId),
          organizer: { toString: () => ownerAId },
        }),
      });

      await expect(service.findByEvent(eventAId, userBId)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockInvitationModel.find).not.toHaveBeenCalled();
    });
  });

  describe('invalid ObjectId → BadRequestException', () => {
    it('devrait lancer BadRequestException pour un ObjectId invalide', async () => {
      await expect(service.findByEvent('not-a-valid-id', ownerAId)).rejects.toThrow(
        BadRequestException,
      );
      expect(eventModel.findById).not.toHaveBeenCalled();
      expect(mockInvitationModel.find).not.toHaveBeenCalled();
    });

    it('devrait lancer BadRequestException pour une chaîne vide', async () => {
      await expect(service.findByEvent('', ownerAId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('devrait lancer BadRequestException pour un id trop court', async () => {
      await expect(service.findByEvent('abc123', ownerAId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('event not found → NotFoundException', () => {
    it('devrait lancer NotFoundException si l\'événement est introuvable', async () => {
      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(null),
      });

      await expect(service.findByEvent(eventAId, ownerAId)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockInvitationModel.find).not.toHaveBeenCalled();
    });
  });

  describe('response never contains tokenHash or token field', () => {
    it('devrait exclure tokenHash et token même si le document lean les expose', async () => {
      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventAId),
          organizer: { toString: () => ownerAId },
        }),
      });

      // Simulate a legacy document that somehow has these fields
      const legacyInvitation = {
        _id: new Types.ObjectId(),
        email: 'legacy@example.com',
        name: 'Legacy User',
        type: InvitationType.PARTICIPANT,
        status: 'pending',
        tokenPrefix: 'pref1234',
        tokenHash: 'very-secret-hash-value',
        token: 'very-secret-raw-token',
        maxUses: 1,
        useCount: 0,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      };

      mockInvitationModel.find.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([legacyInvitation]),
      });

      const result = await service.findByEvent(eventAId, ownerAId);

      expect(result.data).toHaveLength(1);
      // The DTO mapping never copies tokenHash or token
      expect(result.data[0]).not.toHaveProperty('tokenHash');
      expect(result.data[0]).not.toHaveProperty('token');
      expect(result.data[0]).not.toHaveProperty('tokenPrefix');

      // Verify the select call excluded sensitive fields
      const findChain = mockInvitationModel.find.mock.results[0].value as {
        select: jest.Mock;
      };
      expect(findChain.select).toHaveBeenCalledWith('-tokenHash -token -tokenPrefix -__v');
    });
  });

  describe('admin peut accéder aux invitations de n\'importe quel événement', () => {
    it('devrait autoriser un admin même s\'il n\'est pas propriétaire', async () => {
      const adminId = new Types.ObjectId().toString();

      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventAId),
          // Different owner
          organizer: { toString: () => ownerAId },
        }),
      });

      mockInvitationModel.find.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });

      await expect(service.findByEvent(eventAId, adminId, ['admin'])).resolves.toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 25,
      });
    });
  });
});
