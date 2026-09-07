import { resolveCookieDomain } from './cookie-domain';
import { resolveElintysEnvironment } from './elintys-environment';
import {
  resolvePaidTicketHoldMinutes,
  resolveTestPaymentProviderEnabled,
} from './ticketing-environment';
import { resolvePayPalConfig } from './paypal-environment';

export default () => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const elintysEnv = resolveElintysEnvironment(
    process.env.ELINTYS_ENV,
    nodeEnv,
  );
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  resolveCookieDomain(process.env.COOKIE_DOMAIN);

  return {
    port: parseInt(process.env.PORT ?? '3001', 10),
    nodeEnv,
    elintysEnv,
    /**
     * Nombre de proxys de confiance devant l'API.
     *
     * Express n'accorde aucune confiance à `X-Forwarded-For` par défaut :
     * `req.ip` vaut alors l'adresse de la socket, c'est-à-dire celle du proxy
     * de la plateforme. Tous les visiteurs partagent alors une seule et même
     * clé de rate-limiting.
     *
     * La valeur est un **nombre de sauts**, jamais `true` : Express retient
     * l'adresse observée par le proxy le plus proche de nous, si bien qu'un
     * en-tête forgé par le client reste plus à gauche dans la chaîne et n'est
     * jamais retenu.
     */
    trustedProxyHops: parseInt(
      process.env.TRUSTED_PROXY_HOPS ?? (nodeEnv === 'production' ? '1' : '0'),
      10,
    ),
    jwt: {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      // Fail closed: paid checkout is unsafe until stock is reserved before payment.
      checkoutEnabled: process.env.PAID_CHECKOUT_ENABLED === 'true',
    },
    resend: {
      apiKey: process.env.RESEND_API_KEY,
    },
    email: {
      from: process.env.EMAIL_FROM ?? 'Elintys <no-reply@elintys.com>',
    },
    cloudinary: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      apiSecret: process.env.CLOUDINARY_API_SECRET,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    /**
     * PayPal — piloté par configuration.
     *
     * `resolvePayPalConfig` est la SOURCE DE VÉRITÉ unique : elle dérive l'hôte
     * API et les hôtes d'approbation depuis `PAYPAL_ENV`, et lève au démarrage
     * si la configuration est incomplète ou incohérente. `elintysEnv` et
     * `nodeEnv` lui sont transmis pour information : ils ne décident JAMAIS de
     * l'environnement de paiement.
     */
    paypal: resolvePayPalConfig(
      {
        enabled: process.env.PAYPAL_PROVIDER_ENABLED,
        environment: process.env.PAYPAL_ENV,
        clientId: process.env.PAYPAL_CLIENT_ID,
        clientSecret: process.env.PAYPAL_CLIENT_SECRET,
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
      },
      elintysEnv,
      nodeEnv,
    ),
    ticketing: {
      /**
       * Durée de la réservation temporaire de stock d'une commande payante.
       * Source unique de vérité — ne jamais recopier la valeur dans un service.
       */
      holdMinutes: resolvePaidTicketHoldMinutes(process.env.PAID_TICKET_HOLD_MINUTES),
      /**
       * Fournisseur de paiement simulé. Fail-closed : impossible hors dev
       * (cf. resolveTestPaymentProviderEnabled — lève au démarrage).
       */
      testPaymentProviderEnabled: resolveTestPaymentProviderEnabled(
        process.env.TEST_PAYMENT_PROVIDER_ENABLED,
        elintysEnv,
        nodeEnv,
      ),
    },
    frontendUrl,
    authCookie: {
      secure: nodeEnv === 'production',
    },
  };
};
