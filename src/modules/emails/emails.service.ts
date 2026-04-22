import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(private readonly configService: ConfigService) {}

  // Implémentation Resend dans la session dédiée aux emails
  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const apiKey = this.configService.getOrThrow<string>('resend.apiKey');
    this.logger.log(`Envoi d'un courriel à ${to} [${subject}]`);
    // TODO: intégration Resend
    void apiKey;
  }
}
