import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailsService } from './emails.service';

const mockResendSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockResendSend },
  })),
}));

describe('EmailsService', () => {
  let service: EmailsService;

  beforeEach(async () => {
    mockResendSend.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockImplementation((key: string) => {
              const map: Record<string, string> = {
                'resend.apiKey': 're_test_xxx',
                'email.from':    'Elintys <noreply@elintys.ca>',
                'frontendUrl':   'http://localhost:3000',
              };
              return map[key] ?? 'value';
            }),
          },
        },
      ],
    }).compile();

    service = module.get<EmailsService>(EmailsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── sendEmail ──
  describe('sendEmail', () => {
    it('envoie le courriel via Resend et journalise l\'ID de confirmation', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-123' }, error: null });

      await expect(
        service.sendEmail('user@exemple.ca', 'Sujet test', '<p>Bonjour</p>'),
      ).resolves.toBeUndefined();

      expect(mockResendSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to:      'user@exemple.ca',
          subject: 'Sujet test',
          from:    'Elintys <noreply@elintys.ca>',
        }),
      );
    });

    it('lève ServiceUnavailableException si Resend retourne une erreur', async () => {
      mockResendSend.mockResolvedValue({
        data: null,
        error: { name: 'validation_error', statusCode: 422, message: 'Invalid email' },
      });

      await expect(
        service.sendEmail('invalide@exemple.ca', 'Sujet', '<p>Test</p>'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  // ── sendEmailVerification ──
  describe('sendEmailVerification', () => {
    it('envoie un courriel de vérification avec le lien correct', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-456' }, error: null });

      await service.sendEmailVerification('user@exemple.ca', {
        fullName: 'Marie Dupuis',
        token:    'abc123token',
      });

      expect(mockResendSend).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Vérifiez votre adresse courriel — Elintys',
          html:    expect.stringContaining('abc123token'),
        }),
      );
    });
  });

  // ── sendPasswordReset ──
  describe('sendPasswordReset', () => {
    it('envoie un courriel de réinitialisation avec le lien correct', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-789' }, error: null });

      await service.sendPasswordReset('user@exemple.ca', {
        fullName: 'Jean Tremblay',
        token:    'reset456token',
      });

      expect(mockResendSend).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Réinitialisation de votre mot de passe — Elintys',
          html:    expect.stringContaining('reset456token'),
        }),
      );
    });
  });

  // ── sendTicketConfirmation ──
  describe('sendTicketConfirmation', () => {
    it('envoie un courriel de confirmation avec les codes QR', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-abc' }, error: null });

      await service.sendTicketConfirmation('user@exemple.ca', {
        fullName:       'Marie Dupuis',
        eventTitle:     'Gala de Montréal',
        ticketTypeName: 'VIP',
        quantity:       2,
        totalPrice:     10000,
        qrCodes:        ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'],
      });

      const callArg: { html: string } = mockResendSend.mock.calls[0][0] as { html: string };
      expect(callArg.html).toContain('AAAA-BBBB-CCCC');
      expect(callArg.html).toContain('DDDD-EEEE-FFFF');
      expect(callArg.html).toContain('100.00 $');
    });
  });

  // ── sendWelcome ──
  describe('sendWelcome', () => {
    it('envoie un courriel de bienvenue avec le prénom', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-def' }, error: null });

      await service.sendWelcome('user@exemple.ca', { fullName: 'Jean Tremblay' });

      const callArg: { html: string } = mockResendSend.mock.calls[0][0] as { html: string };
      expect(callArg.html).toContain('Jean Tremblay');
    });
  });
});
