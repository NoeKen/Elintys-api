import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);
  private readonly resend: Resend;
  private readonly from: string;
  private readonly frontendUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.resend = new Resend(this.configService.getOrThrow<string>('resend.apiKey'));
    this.from = this.configService.getOrThrow<string>('email.from');
    this.frontendUrl = this.configService.getOrThrow<string>('frontendUrl');
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    this.logger.log(`Envoi d'un courriel à ${to} [${subject}]`);
    const { data, error } = await this.resend.emails.send({ from: this.from, to, subject, html });

    if (error) {
      this.logger.error(
        `Resend a refusé l'envoi à ${to} [${subject}] (${error.name} ${error.statusCode ?? 'n/a'}): ${error.message}`,
      );
      throw new ServiceUnavailableException("Impossible d'envoyer le courriel pour le moment.");
    }

    this.logger.log(`Courriel accepté par Resend: ${data.id}`);
  }

  // ── E-01 : Confirmation d'achat de billet ──
  async sendTicketConfirmation(to: string, opts: {
    fullName: string;
    eventTitle: string;
    ticketTypeName: string;
    quantity: number;
    totalPrice: number;
    qrCodes: string[];
  }): Promise<void> {
    const qrList = opts.qrCodes
      .map((q) => `<li style="font-family:monospace;font-size:18px;letter-spacing:2px;color:#0D1E35;">${q}</li>`)
      .join('');

    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Vos billets sont confirmés !</h2>
      <p style="color:#444;">Bonjour ${opts.fullName},</p>
      <p style="color:#444;">Votre achat de <strong>${opts.quantity} billet(s)</strong> pour <strong>${opts.eventTitle}</strong> (${opts.ticketTypeName}) est confirmé.</p>
      <p style="color:#444;"><strong>Total : ${(opts.totalPrice / 100).toFixed(2)} $</strong></p>
      <p style="color:#0D1E35;font-weight:600;margin-top:24px;">Vos codes QR :</p>
      <ul style="padding-left:20px;">${qrList}</ul>
      <p style="color:#666;font-size:13px;margin-top:16px;">Présentez ces codes à l'entrée de l'événement.</p>
      ${this.ctaButton(`${this.frontendUrl}/mes-billets`, 'Voir mes billets')}
    `);

    await this.sendEmail(to, `Confirmation — ${opts.eventTitle}`, html);
  }

  // ── E-02 : Bienvenue ──
  async sendWelcome(to: string, opts: { fullName: string }): Promise<void> {
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Bienvenue sur Elintys !</h2>
      <p style="color:#444;">Bonjour ${opts.fullName},</p>
      <p style="color:#444;">Votre compte a été créé avec succès. Elintys vous permet de découvrir, organiser et vivre les meilleurs événements au Québec.</p>
      ${this.ctaButton(`${this.frontendUrl}/tableau-de-bord`, 'Accéder à mon tableau de bord')}
    `);

    await this.sendEmail(to, 'Bienvenue sur Elintys !', html);
  }

  // ── E-03 : Vérification de courriel ──
  async sendEmailVerification(to: string, opts: { fullName: string; token: string }): Promise<void> {
    const link = `${this.frontendUrl}/verification-email?token=${opts.token}`;
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Vérifiez votre adresse courriel</h2>
      <p style="color:#444;">Bonjour ${opts.fullName},</p>
      <p style="color:#444;">Cliquez sur le bouton ci-dessous pour vérifier votre adresse courriel et activer votre compte.</p>
      ${this.ctaButton(link, 'Vérifier mon courriel')}
      <p style="color:#888;font-size:12px;margin-top:24px;">Ce lien expire dans 24 heures. Si vous n'avez pas créé de compte, ignorez ce message.</p>
    `);

    await this.sendEmail(to, 'Vérifiez votre adresse courriel — Elintys', html);
  }

  // ── E-04 : Nouvelle demande (prestataire/salle) ──
  async sendNewRequest(to: string, opts: {
    organizerName: string;
    vendorName: string;
    eventTitle: string;
    requestUrl: string;
  }): Promise<void> {
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Nouvelle demande de collaboration</h2>
      <p style="color:#444;">Bonjour ${opts.vendorName},</p>
      <p style="color:#444;"><strong>${opts.organizerName}</strong> vous a envoyé une demande pour l'événement <strong>${opts.eventTitle}</strong>.</p>
      ${this.ctaButton(opts.requestUrl, 'Voir la demande')}
    `);

    await this.sendEmail(to, `Nouvelle demande — ${opts.eventTitle}`, html);
  }

  // ── E-05 : Demande acceptée ──
  async sendRequestAccepted(to: string, opts: {
    vendorName: string;
    organizerName: string;
    eventTitle: string;
    eventUrl: string;
  }): Promise<void> {
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Votre demande a été acceptée !</h2>
      <p style="color:#444;">Bonjour ${opts.organizerName},</p>
      <p style="color:#444;"><strong>${opts.vendorName}</strong> a accepté votre demande pour l'événement <strong>${opts.eventTitle}</strong>.</p>
      ${this.ctaButton(opts.eventUrl, 'Gérer mon événement')}
    `);

    await this.sendEmail(to, `Demande acceptée — ${opts.eventTitle}`, html);
  }

  // ── E-08 : Rappel d'événement ──
  async sendEventReminder(to: string, opts: {
    fullName: string;
    eventTitle: string;
    startDate: string;
    eventUrl: string;
  }): Promise<void> {
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Rappel — ${opts.eventTitle}</h2>
      <p style="color:#444;">Bonjour ${opts.fullName},</p>
      <p style="color:#444;">L'événement <strong>${opts.eventTitle}</strong> aura lieu le <strong>${opts.startDate}</strong>. Ne l'oubliez pas !</p>
      ${this.ctaButton(opts.eventUrl, 'Voir les détails')}
    `);

    await this.sendEmail(to, `Rappel — ${opts.eventTitle}`, html);
  }

  // ── E-09 : Invitation à laisser un avis ──
  async sendRatingReminder(to: string, opts: {
    fullName: string;
    eventTitle: string;
    reviewUrl: string;
  }): Promise<void> {
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Comment s'est passé l'événement ?</h2>
      <p style="color:#444;">Bonjour ${opts.fullName},</p>
      <p style="color:#444;">Vous avez assisté à <strong>${opts.eventTitle}</strong>. Votre avis nous aide à améliorer l'expérience pour tous.</p>
      ${this.ctaButton(opts.reviewUrl, 'Laisser un avis')}
    `);

    await this.sendEmail(to, `Donnez votre avis — ${opts.eventTitle}`, html);
  }

  // ── E-11 : Réinitialisation du mot de passe ──
  async sendPasswordReset(to: string, opts: { fullName: string; token: string }): Promise<void> {
    const link = `${this.frontendUrl}/reinitialiser-mot-de-passe?token=${opts.token}`;
    const html = this.baseTemplate(`
      <h2 style="color:#0D1E35;margin:0 0 16px;">Réinitialisation de votre mot de passe</h2>
      <p style="color:#444;">Bonjour ${opts.fullName},</p>
      <p style="color:#444;">Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.</p>
      ${this.ctaButton(link, 'Réinitialiser mon mot de passe')}
      <p style="color:#888;font-size:12px;margin-top:24px;">Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez ce message.</p>
    `);

    await this.sendEmail(to, 'Réinitialisation de votre mot de passe — Elintys', html);
  }

  private baseTemplate(content: string): string {
    return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F4F4F0;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F0;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#0D1E35;padding:24px 32px;">
            <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">Elintys</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td style="background-color:#F4F4F0;padding:20px 32px;text-align:center;">
            <p style="color:#999;font-size:12px;margin:0;">© ${new Date().getFullYear()} Elintys — Montréal, Québec</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private ctaButton(url: string, label: string): string {
    return `<div style="text-align:center;margin:28px 0;">
      <a href="${url}" style="background-color:#1A7A5E;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block;">${label}</a>
    </div>`;
  }
}
