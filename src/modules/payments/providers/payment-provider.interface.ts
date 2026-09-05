/**
 * Abstraction de fournisseur de paiement.
 *
 * PRINCIPE : Stripe n'est pas le domaine métier. Le domaine Ticketing possède
 * la commande, la réservation de stock et l'admission. Le fournisseur de
 * paiement n'est qu'un adaptateur remplaçable.
 *
 * Le contrat est délibérément minimal — il n'expose QUE les trois opérations
 * réellement utilisées par le flux de commande :
 *
 *   1. `createPayment`     à la création de la commande (après réservation du stock)
 *   2. `getPaymentStatus`  quand le serveur veut connaître l'issue faisant autorité
 *   3. `cancelPayment`     à l'annulation acheteur ou à l'expiration du hold
 *
 * Ce qui n'y figure PAS, volontairement :
 *   - remboursement (hors périmètre Vague 5)
 *   - payout / transfert (hors périmètre)
 *   - capture différée (aucun cas d'usage aujourd'hui)
 *
 * RÈGLE DE SÉCURITÉ : le statut d'un paiement est TOUJOURS obtenu du
 * fournisseur par le serveur. Aucun endpoint n'accepte un statut de paiement
 * fourni par le client.
 */

export const PAYMENT_PROVIDER_TOKENS = {
  TEST: 'test',
  STRIPE: 'stripe',
  PAYPAL: 'paypal',
} as const;

export type PaymentProviderName =
  (typeof PAYMENT_PROVIDER_TOKENS)[keyof typeof PAYMENT_PROVIDER_TOKENS];

/**
 * Statuts de paiement normalisés, indépendants du fournisseur.
 *
 * `PENDING` couvre à la fois « pas encore payé » et « en cours de traitement ».
 * Le domaine Ticketing ne fait pas la différence : dans les deux cas la
 * commande reste PENDING_PAYMENT jusqu'à l'expiration du hold.
 */
export enum ProviderPaymentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface CreatePaymentInput {
  /** Identifiant de la commande Elintys. Sert de clé d'idempotence côté fournisseur. */
  orderId: string;
  /** Montant total en plus petite unité monétaire (cents CAD). Entier. */
  amount: number;
  currency: 'cad';
  /** Libellé affiché à l'acheteur. Jamais de donnée sensible. */
  description: string;
  /** Courriel de l'acheteur, si connu côté serveur. Jamais fourni par le client. */
  customerEmail?: string;
  /** Fin de la réservation de stock — le fournisseur peut aligner sa propre expiration. */
  expiresAt: Date;
  /**
   * Scénario de simulation. Ignoré par tout fournisseur réel.
   * Uniquement consommé par TestPaymentProvider, lui-même impossible en production.
   */
  scenario?: string;
}

export interface PaymentHandle {
  provider: PaymentProviderName;
  /** Référence opaque du fournisseur. Jamais générée ni choisie par le client. */
  reference: string;
  status: ProviderPaymentStatus;
  /** URL de paiement hébergée, si le fournisseur en expose une. */
  checkoutUrl: string | null;

  /**
   * Champs de RÈGLEMENT — Vague 6, tous optionnels.
   *
   * Certains fournisseurs distinguent l'autorisation du règlement effectif
   * (PayPal : order puis capture). Ces champs décrivent le règlement lorsqu'il
   * existe, sans imposer cette notion aux fournisseurs qui règlent en une
   * étape (Stripe Checkout, TestPaymentProvider).
   */

  /** Référence du règlement (capture, charge…), distincte de `reference`. */
  settlementReference?: string | null;
  /** Montant réellement réglé, en unités mineures. Vérifié par le domaine. */
  settledAmountMinorUnits?: number | null;
  /** Devise du règlement, en ISO-4217. Vérifiée par le domaine. */
  settledCurrency?: string | null;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;

  createPayment(input: CreatePaymentInput): Promise<PaymentHandle>;

  /** Issue faisant autorité, lue chez le fournisseur. */
  getPaymentStatus(reference: string): Promise<ProviderPaymentStatus>;

  /**
   * Annulation best-effort côté fournisseur.
   * Doit être idempotente : une deuxième annulation ne doit pas échouer.
   */
  cancelPayment(reference: string): Promise<void>;

  /**
   * RÈGLEMENT EN DEUX TEMPS — optionnel (Vague 6).
   *
   * Implémenté uniquement par les fournisseurs qui séparent l'approbation de
   * l'acheteur du transfert effectif des fonds. Le serveur — jamais le client —
   * déclenche cette étape et vérifie le montant réglé.
   *
   * Doit être IDEMPOTENT : un second appel pour un règlement déjà effectué
   * renvoie le même résultat sans créer de second débit.
   */
  confirmPayment?(input: { reference: string; orderId: string }): Promise<PaymentHandle>;
}
