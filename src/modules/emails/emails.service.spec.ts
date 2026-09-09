import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailsService } from './emails.service';

// Ferme le module Nest après chaque test : sans cela, des handles
// restent ouverts et Jest force la sortie du worker (finding F-011).
let testingModule: TestingModule;
afterEach(async () => {
  await testingModule?.close();
});

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

    testingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) =>
              key === 'email.enabled' ? true : undefined,
            ),
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

    service = testingModule.get<EmailsService>(EmailsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── sendEmail ──
  describe('sendEmail', () => {
    it('ne contacte pas le fournisseur lorsque le transport est désactivé', async () => {
      Object.defineProperty(service, 'deliveryEnabled', { value: false });

      await expect(
        service.sendEmail('user@exemple.ca', 'Sujet test', '<p>Bonjour</p>'),
      ).resolves.toBeUndefined();

      expect(mockResendSend).not.toHaveBeenCalled();
    });

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

    it('ne journalise ni adresse complète ni contenu du sujet', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-private' }, error: null });
      const logSpy = jest.spyOn(
        (service as unknown as { logger: { log: (message: string) => void } }).logger,
        'log',
      );

      await service.sendEmail(
        'personne.privee@exemple.ca',
        'Événement médical confidentiel',
        '<p>Test</p>',
      );

      const logs = logSpy.mock.calls.flat().join(' ');
      expect(logs).not.toContain('personne.privee@exemple.ca');
      expect(logs).not.toContain('Événement médical confidentiel');
    });

    it('lève ServiceUnavailableException si Resend retourne une erreur', async () => {
      const logSpy = jest.spyOn(
        (service as unknown as { logger: { error: (message: string) => void } }).logger,
        'error',
      );
      mockResendSend.mockResolvedValue({
        data: null,
        error: {
          name: 'validation_error',
          statusCode: 422,
          message: 'Invalid recipient personne.privee@exemple.ca',
        },
      });

      await expect(
        service.sendEmail('invalide@exemple.ca', 'Sujet', '<p>Test</p>'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('personne.privee@exemple.ca');
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

  describe('sendNewRequest', () => {
    it('échappe les champs utilisateur interpolés dans le HTML', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-request' }, error: null });

      await service.sendNewRequest('vendor@exemple.ca', {
        organizerName: '<img src=x onerror=alert(1)>',
        vendorName: '<script>alert(2)</script>',
        eventTitle: 'Gala <b>privé</b>',
        requestUrl: 'http://localhost:3000/tableau-de-bord/prestataire/demandes',
      });

      const callArg = mockResendSend.mock.calls[0][0] as { html: string };
      expect(callArg.html).not.toContain('<script>');
      expect(callArg.html).not.toContain('<img');
      expect(callArg.html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
      expect(callArg.html).toContain('Gala &lt;b&gt;privé&lt;/b&gt;');
    });
  });

  describe('sendVenueBookingRequest', () => {
    it('génère un courriel de demande de lieu sans HTML injecté', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-venue-request' }, error: null });

      await service.sendVenueBookingRequest('venue@exemple.ca', {
        managerName: '<img src=x onerror=alert(1)>',
        organizerName: '<script>alert(2)</script>',
        venueName: '<b>Salle</b>',
        eventTitle: 'Gala <i>privé</i>',
        requestUrl: 'http://localhost:3000/tableau-de-bord/gestionnaire/reservations',
      });

      const callArg = mockResendSend.mock.calls[0][0] as { html: string };
      expect(callArg.html).not.toContain('<script>');
      expect(callArg.html).not.toContain('<img');
      expect(callArg.html).toContain('&lt;b&gt;Salle&lt;/b&gt;');
      expect(callArg.html).toContain('Gala &lt;i&gt;privé&lt;/i&gt;');
    });
  });

  describe('sendVendorRequestUpdate', () => {
    it.each(['accepted', 'declined'] as const)(
      'génère un courriel échappé pour une réponse %s',
      async (status) => {
        mockResendSend.mockResolvedValue({ data: { id: 'email-id-vendor-update' }, error: null });

        await service.sendVendorRequestUpdate('organizer@exemple.ca', {
          vendorName: '<img src=x onerror=alert(1)>',
          organizerName: '<script>alert(2)</script>',
          eventTitle: '<b>Gala</b>',
          status,
          eventUrl: 'http://localhost:3000/tableau-de-bord/evenements/507f1f77bcf86cd799439011/prestataires',
        });

        const callArg = mockResendSend.mock.calls[0][0] as { html: string };
        expect(callArg.html).not.toContain('<script>');
        expect(callArg.html).not.toContain('<img');
        expect(callArg.html).toContain('&lt;b&gt;Gala&lt;/b&gt;');
      },
    );
  });

  it('échappe les contenus métier dans tous les gabarits transactionnels actifs', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 'email-id-template' }, error: null });
    const attack = '<img src=x onerror=alert(1)>';

    await service.sendWelcome('user@exemple.ca', { fullName: attack });
    await service.sendTicketConfirmation('user@exemple.ca', {
      fullName: attack,
      eventTitle: attack,
      ticketTypeName: attack,
      quantity: 1,
      totalPrice: 0,
      qrCodes: [attack],
    });
    await service.sendEventReminder('user@exemple.ca', {
      fullName: attack,
      eventTitle: attack,
      startDate: attack,
      eventUrl: 'http://localhost:3000/evenements/test',
    });
    await service.sendRatingReminder('user@exemple.ca', {
      fullName: attack,
      eventTitle: attack,
      reviewUrl: 'http://localhost:3000',
    });
    await service.sendInvitationEmail('user@exemple.ca', {
      inviterName: attack,
      type: 'vendor',
      eventTitle: attack,
      invitationLink: 'http://localhost:3000/invitations/test',
    });
    await service.sendWaitlistConfirmation('user@exemple.ca', {
      firstName: attack,
      role: 'organisateur',
    });

    for (const [input] of mockResendSend.mock.calls) {
      expect((input as { html: string }).html).not.toContain('<img src=x');
    }
  });

  describe('sendVenueBookingUpdate', () => {
    it('échappe le message et les champs métier avant de générer le HTML', async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-venue' }, error: null });

      await service.sendVenueBookingUpdate('organizer@exemple.ca', {
        fullName: '<img src=x onerror=alert(1)>',
        venueName: '<b>Salle</b>',
        eventTitle: '<script>event</script>',
        status: 'confirmed',
        message: '<a href=https://evil.example>cliquez</a>',
      });

      const callArg = mockResendSend.mock.calls[0][0] as { html: string };
      expect(callArg.html).not.toContain('<script>');
      expect(callArg.html).not.toContain('<img');
      expect(callArg.html).not.toContain('<a href=https://evil.example>');
      expect(callArg.html).toContain('&lt;b&gt;Salle&lt;/b&gt;');
      expect(callArg.html).toContain('&lt;a href=https://evil.example&gt;cliquez&lt;/a&gt;');
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

  // ── sendWaitlistConfirmation ──
  describe('sendWaitlistConfirmation', () => {
    it("devrait envoyer un courriel de confirmation avec les points forts du rôle choisi", async () => {
      mockResendSend.mockResolvedValue({ data: { id: 'email-id-ghi' }, error: null });

      await service.sendWaitlistConfirmation('user@exemple.ca', {
        firstName: 'Marie',
        role: 'prestataire',
      });

      expect(mockResendSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@exemple.ca',
          subject: 'Vous êtes sur la liste Elintys !',
          html: expect.stringContaining('Marie'),
        }),
      );
      const callArg: { html: string } = mockResendSend.mock.calls[0][0] as { html: string };
      expect(callArg.html).toContain('bouche-à-oreille');
    });
  });
});
