/**
 * Conversion monétaire domaine ↔ PayPal.
 *
 * Le domaine Elintys stocke TOUJOURS des unités mineures entières
 * (4995 = 49,95 $ CAD). PayPal attend une chaîne décimale ("49.95").
 *
 * La conversion est déterministe et réversible : `fromPayPalValue` doit
 * redonner exactement l'entier de départ. Toute divergence est une erreur de
 * programmation, jamais un arrondi silencieux.
 *
 * Aucun montant ne provient jamais du frontend : la source est le TicketOrder.
 */

export const PAYPAL_MONEY_INVALID_AMOUNT = 'PAYPAL_MONEY_INVALID_AMOUNT';
export const PAYPAL_MONEY_UNSUPPORTED_CURRENCY = 'PAYPAL_MONEY_UNSUPPORTED_CURRENCY';
export const PAYPAL_MONEY_MISMATCH = 'PAYPAL_MONEY_MISMATCH';

export class PayPalMoneyError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PayPalMoneyError';
  }
}

/** Nombre de décimales par devise ISO-4217. Le domaine est CAD aujourd'hui. */
const CURRENCY_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  CAD: 2,
});

export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export function currencyDecimals(currencyCode: string): number {
  const decimals = CURRENCY_DECIMALS[currencyCode.toUpperCase()];
  if (decimals === undefined) {
    throw new PayPalMoneyError(PAYPAL_MONEY_UNSUPPORTED_CURRENCY);
  }
  return decimals;
}

/** 4995 + 'cad' → { currency_code: 'CAD', value: '49.95' } */
export function toPayPalAmount(minorUnits: number, currency: string): PayPalAmount {
  const currencyCode = currency.toUpperCase();
  const decimals = currencyDecimals(currencyCode);

  if (!Number.isInteger(minorUnits) || minorUnits < 0 || !Number.isSafeInteger(minorUnits)) {
    throw new PayPalMoneyError(PAYPAL_MONEY_INVALID_AMOUNT);
  }

  const factor = 10 ** decimals;
  const whole = Math.floor(minorUnits / factor);
  const fraction = minorUnits % factor;
  const value = decimals === 0
    ? String(whole)
    : `${whole}.${String(fraction).padStart(decimals, '0')}`;

  return { currency_code: currencyCode, value };
}

/** '49.95' + 'CAD' → 4995. Rejette toute valeur non exactement représentable. */
export function fromPayPalValue(value: string, currency: string): number {
  const currencyCode = currency.toUpperCase();
  const decimals = currencyDecimals(currencyCode);

  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+\\.\\d{${decimals}}$`);
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new PayPalMoneyError(PAYPAL_MONEY_INVALID_AMOUNT);
  }

  const [whole, fraction = ''] = value.split('.');
  const minorUnits = Number(whole) * 10 ** decimals + Number(fraction || '0');
  if (!Number.isSafeInteger(minorUnits)) {
    throw new PayPalMoneyError(PAYPAL_MONEY_INVALID_AMOUNT);
  }
  return minorUnits;
}

/**
 * Vérifie qu'un montant renvoyé par PayPal correspond EXACTEMENT au montant
 * attendu par le domaine. Utilisé avant toute finalisation : une capture dont
 * le montant ou la devise diverge n'est jamais honorée.
 */
export function assertAmountMatches(
  expectedMinorUnits: number,
  expectedCurrency: string,
  actual: { currency_code?: string; value?: string } | null | undefined,
): void {
  if (!actual?.currency_code || !actual.value) {
    throw new PayPalMoneyError(PAYPAL_MONEY_MISMATCH);
  }
  if (actual.currency_code.toUpperCase() !== expectedCurrency.toUpperCase()) {
    throw new PayPalMoneyError(PAYPAL_MONEY_MISMATCH);
  }
  if (fromPayPalValue(actual.value, actual.currency_code) !== expectedMinorUnits) {
    throw new PayPalMoneyError(PAYPAL_MONEY_MISMATCH);
  }
}
