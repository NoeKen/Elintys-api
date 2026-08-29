import {
  assertAmountMatches,
  currencyDecimals,
  fromPayPalValue,
  PAYPAL_MONEY_INVALID_AMOUNT,
  PAYPAL_MONEY_MISMATCH,
  PAYPAL_MONEY_UNSUPPORTED_CURRENCY,
  PayPalMoneyError,
  toPayPalAmount,
} from './paypal-money';

describe('toPayPalAmount', () => {
  it.each([
    [4995, '49.95'],
    [100, '1.00'],
    [5, '0.05'],
    [0, '0.00'],
    [1_234_567, '12345.67'],
  ])('devrait convertir %d cents en %s', (cents, expected) => {
    expect(toPayPalAmount(cents, 'cad')).toEqual({ currency_code: 'CAD', value: expected });
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'devrait refuser le montant invalide %p',
    (amount) => {
      expect(() => toPayPalAmount(amount, 'cad')).toThrow(PAYPAL_MONEY_INVALID_AMOUNT);
    },
  );

  it('devrait refuser une devise non supportée', () => {
    expect(() => toPayPalAmount(100, 'eur')).toThrow(PAYPAL_MONEY_UNSUPPORTED_CURRENCY);
    expect(() => currencyDecimals('JPY')).toThrow(PAYPAL_MONEY_UNSUPPORTED_CURRENCY);
  });
});

describe('fromPayPalValue', () => {
  it.each([
    ['49.95', 4995],
    ['0.05', 5],
    ['0.00', 0],
    ['12345.67', 1_234_567],
  ])('devrait convertir %s en %d cents', (value, expected) => {
    expect(fromPayPalValue(value, 'CAD')).toBe(expected);
  });

  it.each(['49.9', '49', '49.955', '-1.00', 'abc', '', '4 9.95'])(
    'devrait refuser la valeur mal formée %p',
    (value) => {
      expect(() => fromPayPalValue(value, 'CAD')).toThrow(PAYPAL_MONEY_INVALID_AMOUNT);
    },
  );

  it('devrait être exactement réversible', () => {
    for (const cents of [0, 1, 99, 100, 4995, 999_999]) {
      const amount = toPayPalAmount(cents, 'cad');
      expect(fromPayPalValue(amount.value, amount.currency_code)).toBe(cents);
    }
  });
});

describe('assertAmountMatches', () => {
  it('devrait accepter un montant et une devise identiques', () => {
    expect(() =>
      assertAmountMatches(4995, 'cad', { currency_code: 'CAD', value: '49.95' }),
    ).not.toThrow();
  });

  it.each([
    ['montant différent', { currency_code: 'CAD', value: '49.94' }],
    ['devise différente', { currency_code: 'USD', value: '49.95' }],
    ['valeur absente', { currency_code: 'CAD' }],
    ['objet nul', null],
  ])('devrait refuser : %s', (_name, actual) => {
    expect(() => assertAmountMatches(4995, 'cad', actual as never)).toThrow(PayPalMoneyError);
  });

  it('devrait exposer un code stable', () => {
    expect(() => assertAmountMatches(1, 'cad', null)).toThrow(PAYPAL_MONEY_MISMATCH);
  });
});
