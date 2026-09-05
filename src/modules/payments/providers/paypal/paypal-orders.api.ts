import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayPalHttpClient } from './paypal-http.client';
import { toPayPalAmount } from './paypal-money';
import { PayPalOrderSnapshot, RawPayPalOrder, translateOrder } from './paypal.types';

/**
 * Adaptateur de l'API PayPal **Orders v2** (flux Checkout moderne).
 *
 * Choix documenté : Orders v2 avec `intent: CAPTURE` et capture explicite
 * côté serveur. L'API legacy Payments v1 n'est pas utilisée — elle est
 * dépréciée et ne permet pas le découplage approbation/capture attendu ici.
 *
 * Séquence :
 *   createOrder  →  approbation acheteur  →  captureOrder  →  webhook
 *
 * Cette classe ne fait que traduire : elle ne connaît ni TicketOrder, ni hold,
 * ni stock. Tous les retours sont des `PayPalOrderSnapshot` internes.
 */
@Injectable()
export class PayPalOrdersApi {
  constructor(
    private readonly http: PayPalHttpClient,
    private readonly configService: ConfigService,
  ) {}

  private get frontendUrl(): string {
    return this.configService.getOrThrow<string>('frontendUrl');
  }

  /**
   * Crée une commande PayPal à partir d'un TicketOrder Elintys déjà persisté.
   *
   * - `custom_id`  : corrélation vers le TicketOrder (indicative).
   * - `invoice_id` : PayPal refuse deux commandes payées avec le même
   *   `invoice_id` pour un même marchand. C'est une protection FOURNISSEUR
   *   contre le double paiement d'une commande, en complément — jamais en
   *   remplacement — des contraintes MongoDB d'Elintys.
   * - `PayPal-Request-Id` : idempotence de la requête de création elle-même ;
   *   un rejeu réseau ne crée pas deux commandes PayPal.
   */
  async createOrder(input: {
    orderId: string;
    amountMinorUnits: number;
    currency: string;
    description: string;
  }): Promise<PayPalOrderSnapshot> {
    const amount = toPayPalAmount(input.amountMinorUnits, input.currency);

    const raw = await this.http.request<RawPayPalOrder>({
      method: 'POST',
      path: '/v2/checkout/orders',
      requestId: `ticket-order-create:${input.orderId}`,
      prefer: 'return=representation',
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.orderId,
            custom_id: input.orderId,
            invoice_id: input.orderId,
            description: input.description.slice(0, 127),
            amount,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${this.frontendUrl}/paiement/succes?order_id=${input.orderId}`,
              cancel_url: `${this.frontendUrl}/paiement/annule?order_id=${input.orderId}`,
            },
          },
        },
      },
    });

    return translateOrder(raw);
  }

  /** Lit l'état faisant autorité d'une commande PayPal. */
  async getOrder(paypalOrderId: string): Promise<PayPalOrderSnapshot> {
    const raw = await this.http.request<RawPayPalOrder>({
      method: 'GET',
      path: `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
    });
    return translateOrder(raw);
  }

  /**
   * Capture une commande approuvée.
   *
   * `PayPal-Request-Id` rend l'appel idempotent : deux captures concurrentes
   * pour la même commande ne produisent qu'une seule capture côté PayPal.
   */
  async captureOrder(paypalOrderId: string, elintysOrderId: string): Promise<PayPalOrderSnapshot> {
    const raw = await this.http.request<RawPayPalOrder>({
      method: 'POST',
      path: `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
      requestId: `ticket-order-capture:${elintysOrderId}`,
      prefer: 'return=representation',
      body: {},
    });
    return translateOrder(raw);
  }
}
