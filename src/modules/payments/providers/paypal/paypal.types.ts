/**
 * Types INTERNES agnostiques du fournisseur.
 *
 * Le domaine Ticketing ne manipule jamais une réponse PayPal brute : ni objet
 * `order`, ni objet `capture`, ni `payer`, ni payload de webhook. Toute donnée
 * PayPal est traduite ici, une seule fois, vers ces structures stables.
 *
 * Conséquence : remplacer PayPal par un autre fournisseur n'impacte que la
 * traduction, jamais le domaine.
 */

/** États de commande PayPal normalisés (Orders v2). */
export enum PayPalOrderState {
  /** Créée, en attente d'approbation de l'acheteur. */
  CREATED = 'CREATED',
  /** Acheteur en cours d'action sur l'interface PayPal. */
  PAYER_ACTION_REQUIRED = 'PAYER_ACTION_REQUIRED',
  /** Approuvée par l'acheteur, pas encore capturée. */
  APPROVED = 'APPROVED',
  /** Capturée — le paiement a effectivement eu lieu. */
  COMPLETED = 'COMPLETED',
  /** Annulée côté PayPal. */
  VOIDED = 'VOIDED',
  /** État inconnu : traité de façon conservatrice (jamais comme un succès). */
  UNKNOWN = 'UNKNOWN',
}

/** États de capture PayPal normalisés. */
export enum PayPalCaptureState {
  COMPLETED = 'COMPLETED',
  PENDING = 'PENDING',
  DECLINED = 'DECLINED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}

export interface PayPalMoneySnapshot {
  currencyCode: string;
  value: string;
}

/**
 * Photographie d'une commande PayPal, réduite à ce dont le domaine a besoin.
 *
 * Les trois identifiants sont distincts et ne doivent jamais être confondus
 * (cf. §19 du cadrage) :
 *   - `orderId`    identifiant de commande PayPal
 *   - `captureId`  identifiant de capture PayPal (le paiement lui-même)
 *   - `customId`   identifiant de TicketOrder Elintys, transporté par PayPal
 */
export interface PayPalOrderSnapshot {
  orderId: string;
  state: PayPalOrderState;
  /** URL vers laquelle envoyer l'acheteur. `null` une fois approuvée. */
  approvalUrl: string | null;
  captureId: string | null;
  captureState: PayPalCaptureState | null;
  amount: PayPalMoneySnapshot | null;
  /** Corrélation métier — indicative, jamais l'autorité (la base l'est). */
  customId: string | null;
}

export function toOrderState(raw: unknown): PayPalOrderState {
  const value = typeof raw === 'string' ? raw.toUpperCase() : '';
  return Object.values(PayPalOrderState).includes(value as PayPalOrderState)
    ? (value as PayPalOrderState)
    : PayPalOrderState.UNKNOWN;
}

export function toCaptureState(raw: unknown): PayPalCaptureState {
  const value = typeof raw === 'string' ? raw.toUpperCase() : '';
  return Object.values(PayPalCaptureState).includes(value as PayPalCaptureState)
    ? (value as PayPalCaptureState)
    : PayPalCaptureState.UNKNOWN;
}

/** Forme minimale des réponses Orders v2 réellement consommées. */
export interface RawPayPalOrder {
  id?: unknown;
  status?: unknown;
  links?: unknown;
  purchase_units?: unknown;
}

/**
 * Traduit une réponse Orders v2 en snapshot interne.
 *
 * Tolérante par construction : tout champ absent ou inattendu produit `null`
 * ou `UNKNOWN`, jamais une exception ni un état optimiste.
 */
export function translateOrder(raw: RawPayPalOrder): PayPalOrderSnapshot {
  const orderId = typeof raw.id === 'string' ? raw.id : '';
  const links = Array.isArray(raw.links) ? (raw.links as Record<string, unknown>[]) : [];
  const approvalLink = links.find(
    (link) => link?.rel === 'payer-action' || link?.rel === 'approve',
  );

  const units = Array.isArray(raw.purchase_units)
    ? (raw.purchase_units as Record<string, unknown>[])
    : [];
  const unit = units[0] ?? {};
  const payments = (unit.payments ?? {}) as Record<string, unknown>;
  const captures = Array.isArray(payments.captures)
    ? (payments.captures as Record<string, unknown>[])
    : [];
  const capture = captures[0];
  const captureAmount = (capture?.amount ?? unit.amount) as Record<string, unknown> | undefined;

  return {
    orderId,
    state: toOrderState(raw.status),
    approvalUrl: typeof approvalLink?.href === 'string' ? approvalLink.href : null,
    captureId: typeof capture?.id === 'string' ? capture.id : null,
    captureState: capture ? toCaptureState(capture.status) : null,
    amount:
      typeof captureAmount?.currency_code === 'string' && typeof captureAmount?.value === 'string'
        ? { currencyCode: captureAmount.currency_code, value: captureAmount.value }
        : null,
    customId: typeof unit.custom_id === 'string' ? unit.custom_id : null,
  };
}
