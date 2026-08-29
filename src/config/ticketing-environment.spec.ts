import {
  DEFAULT_PAID_TICKET_HOLD_MINUTES,
  resolvePaidTicketHoldMinutes,
  resolveTestPaymentProviderEnabled,
} from './ticketing-environment';

describe('resolvePaidTicketHoldMinutes', () => {
  it.each([undefined, '', '   '])(
    'devrait retomber sur la valeur par défaut lorsque la variable vaut %p',
    (raw) => {
      expect(resolvePaidTicketHoldMinutes(raw)).toBe(DEFAULT_PAID_TICKET_HOLD_MINUTES);
    },
  );

  it('devrait accepter une valeur entière valide', () => {
    expect(resolvePaidTicketHoldMinutes('30')).toBe(30);
  });

  it.each(['0', '121', '-5', '10.5', 'abc'])(
    'devrait refuser la valeur invalide %s',
    (raw) => {
      expect(() => resolvePaidTicketHoldMinutes(raw)).toThrow('PAID_TICKET_HOLD_MINUTES');
    },
  );
});

describe('resolveTestPaymentProviderEnabled', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])(
    'devrait rester désactivé lorsque la variable vaut %p',
    (raw) => {
      expect(resolveTestPaymentProviderEnabled(raw, 'dev', 'development')).toBe(false);
    },
  );

  it('devrait autoriser le fournisseur simulé en dev', () => {
    expect(resolveTestPaymentProviderEnabled('true', 'dev', 'development')).toBe(true);
  });

  it.each([
    ['prod', 'production'],
    ['prod', 'development'],
    ['dev', 'production'],
  ])(
    'devrait refuser de démarrer avec ELINTYS_ENV=%s et NODE_ENV=%s',
    (elintysEnv, nodeEnv) => {
      expect(() => resolveTestPaymentProviderEnabled('true', elintysEnv, nodeEnv)).toThrow(
        'TEST_PAYMENT_PROVIDER_ENABLED',
      );
    },
  );

  it("ne devrait jamais lever lorsque l'activation n'est pas demandée en production", () => {
    expect(resolveTestPaymentProviderEnabled(undefined, 'prod', 'production')).toBe(false);
  });
});
