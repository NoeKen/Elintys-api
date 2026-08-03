import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { InvitationsService } from './invitations.service';
import { Invitation, InvitationType } from './invitation.schema';
import { EmailsService } from '../emails/emails.service';
import { User } from '../auth/user.schema';
import { Event } from '../events/event.schema';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

const mockInvitationModel = {
  create: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
};

const mockInvitedById = new Types.ObjectId().toString();

describe('InvitationsService', () => {
  let service: InvitationsService;
  const eventModel = { findById: jest.fn() };

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: getModelToken(Invitation.name), useValue: mockInvitationModel },
        { provide: getModelToken(User.name), useValue: { findById: jest.fn().mockReturnValue({ lean: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue({ fullName: 'Test User' }) }) } },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: EmailsService, useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) } },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue('http://localhost:3000') } },
      ],
    }).compile();
    service = testingModule.get<InvitationsService>(InvitationsService);
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
      // Collision sur l'index métier de déduplication (MongoDB fournit toujours keyPattern).
      mockInvitationModel.create.mockRejectedValueOnce({
        code: 11000,
        keyPattern: { invitedBy: 1, email: 1, eventId: 1, type: 1 },
      });

      await expect(
        service.sendInvitation(mockInvitedById, {
          email: 'dup@example.com',
          name: 'Dup User',
          type: InvitationType.VENDOR,
        }),
      ).rejects.toThrow(ConflictException);
    });

    describe('différenciation des collisions E11000 (F-028)', () => {
      const send = () =>
        service.sendInvitation(mockInvitedById, {
          email: 'x@example.com',
          name: 'X',
          type: InvitationType.VENDOR,
        });

      it('devrait signaler un doublon métier sur l’index à 4 champs (règle réelle)', async () => {
        mockInvitationModel.create.mockRejectedValueOnce({
          code: 11000,
          keyPattern: { invitedBy: 1, email: 1, eventId: 1, type: 1 },
        });
        await expect(send()).rejects.toThrow(ConflictException);
      });

      // L'index legacy à 2 champs a été supprimé de `elintys-dev` (F-032), mais la
      // traduction reste défensive : un environnement non encore migré peut le porter.
      it('devrait rester tolérant à l’index legacy à 2 champs (autres environnements)', async () => {
        mockInvitationModel.create.mockRejectedValueOnce({
          code: 11000,
          keyPattern: { invitedBy: 1, email: 1 },
        });
        await expect(send()).rejects.toThrow(ConflictException);
      });

      it('ne devrait PAS annoncer un doublon métier sur une collision tokenHash', async () => {
        mockInvitationModel.create.mockRejectedValueOnce({
          code: 11000,
          keyPattern: { tokenHash: 1 },
        });
        await expect(send()).rejects.toThrow(InternalServerErrorException);
        await expect(send()).rejects.not.toThrow(ConflictException);
      });

      it('ne devrait PAS annoncer un doublon métier sur une collision token legacy', async () => {
        mockInvitationModel.create.mockRejectedValueOnce({
          code: 11000,
          keyPattern: { token: 1 },
        });
        await expect(send()).rejects.toThrow(InternalServerErrorException);
      });

      it('devrait traiter une collision sur un index inconnu comme une erreur de persistance', async () => {
        mockInvitationModel.create.mockRejectedValueOnce({
          code: 11000,
          keyPattern: { autreChose: 1 },
        });
        await expect(send()).rejects.toThrow(InternalServerErrorException);
      });

      it('ne devrait jamais exposer la valeur en cause ni un secret dans le message', async () => {
        mockInvitationModel.create.mockRejectedValueOnce({
          code: 11000,
          keyPattern: { tokenHash: 1 },
          keyValue: { tokenHash: 'secret-hash-abcdef0123456789' },
          message: 'E11000 duplicate key error … tokenHash: "secret-hash-abcdef0123456789"',
        });
        await expect(send()).rejects.toMatchObject({
          message: expect.not.stringContaining('secret-hash'),
        });
      });

      it('devrait autoriser la même adresse sur deux événements différents (F-032)', async () => {
        // La déduplication porte sur {invitedBy, email, eventId, type} : deux eventId
        // distincts ne doivent produire AUCUNE collision.
        // L'événement doit appartenir à l'inviteur pour passer le contrôle d'ownership.
        eventModel.findById.mockReturnValue({
          lean: jest.fn().mockReturnThis(),
          select: jest.fn().mockResolvedValue({
            organizer: { toString: () => mockInvitedById },
            status: 'draft',
            admissionModes: ['invitation'],
          }),
        });
        mockInvitationModel.create
          .mockResolvedValueOnce({ _id: new Types.ObjectId(), eventId: 'event-A' })
          .mockResolvedValueOnce({ _id: new Types.ObjectId(), eventId: 'event-B' });

        const invite = (eventId: string) =>
          service.sendInvitation(mockInvitedById, {
            email: 'meme@example.com',
            name: 'Meme',
            type: InvitationType.VENDOR,
            eventId,
          });

        await expect(invite(new Types.ObjectId().toString())).resolves.toBeDefined();
        await expect(invite(new Types.ObjectId().toString())).resolves.toBeDefined();
        expect(mockInvitationModel.create).toHaveBeenCalledTimes(2);
        // Deux eventId distincts transmis à la persistance.
        const [first, second] = mockInvitationModel.create.mock.calls as Array<
          [Record<string, unknown>]
        >;
        expect(String(first[0].eventId)).not.toEqual(String(second[0].eventId));
      });

      it('devrait autoriser la même adresse avec deux types différents (F-032)', async () => {
        mockInvitationModel.create
          .mockResolvedValueOnce({ _id: new Types.ObjectId() })
          .mockResolvedValueOnce({ _id: new Types.ObjectId() });

        const invite = (type: InvitationType) =>
          service.sendInvitation(mockInvitedById, {
            email: 'meme@example.com',
            name: 'Meme',
            type,
          });

        await expect(invite(InvitationType.VENDOR)).resolves.toBeDefined();
        await expect(invite(InvitationType.VENUE)).resolves.toBeDefined();
      });

      it('devrait propager telle quelle une erreur non-E11000', async () => {
        const boom = new Error('ECONNRESET');
        mockInvitationModel.create.mockRejectedValueOnce(boom);
        await expect(send()).rejects.toThrow(boom);
      });
    });

    it('ne devrait jamais persister le jeton brut (seulement tokenHash + tokenPrefix)', async () => {
      mockInvitationModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

      await service.sendInvitation(mockInvitedById, {
        email: 'safe@example.com',
        name: 'Safe',
        type: InvitationType.VENDOR,
      });

      const payload = mockInvitationModel.create.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.token).toBeUndefined();
      expect(payload.tokenHash).toEqual(expect.any(String));
      expect(payload.tokenPrefix).toEqual(expect.any(String));
      expect(String(payload.tokenPrefix)).toHaveLength(8);
    });

    it('ne devrait pas retourner tokenHash dans la réponse', async () => {
      mockInvitationModel.create.mockResolvedValueOnce({
        _id: new Types.ObjectId(),
        email: 'a@b.ca',
        tokenHash: 'hash-secret',
        token: 'raw-secret',
        tokenPrefix: 'abcd1234',
      });

      const result = await service.sendInvitation(mockInvitedById, {
        email: 'a@b.ca',
        name: 'A',
        type: InvitationType.VENDOR,
      });

      expect(result).not.toHaveProperty('tokenHash');
      expect(result).not.toHaveProperty('token');
      expect(JSON.stringify(result)).not.toContain('raw-secret');
    });

    it('refuse une invitation liée à l’événement d’un tiers', async () => {
      eventModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({
          organizer: { toString: () => 'other-user' },
          status: 'draft',
          admissionModes: ['invitation'],
        }),
      });
      await expect(service.sendInvitation(mockInvitedById, {
        email: 'participant@example.com',
        name: 'Participant',
        type: InvitationType.PARTICIPANT,
        eventId: new Types.ObjectId().toString(),
      })).rejects.toThrow(ForbiddenException);
      expect(mockInvitationModel.create).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvitation', () => {
    it('devrait lancer NotFoundException si token invalide', async () => {
      mockInvitationModel.findOneAndUpdate.mockReturnValue({
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
      mockInvitationModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValueOnce(mockInvitation),
      });

      const result = await service.acceptInvitation('valid-token');
      expect(result).toBe(mockInvitation);
      expect(mockInvitationModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
        expect.objectContaining({ $inc: { useCount: 1 } }),
        { new: true },
      );
    });
  });

  describe('getMyInvitations', () => {
    it("devrait retourner les invitations de l'utilisateur", async () => {
      const mockInvitations = [{ email: 'a@b.com' }, { email: 'c@d.com' }];
      mockInvitationModel.find.mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValueOnce(mockInvitations),
      });

      const result = await service.getMyInvitations(mockInvitedById);
      expect(result).toHaveLength(2);
    });
  });
});
