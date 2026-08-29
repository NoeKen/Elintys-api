import { CriticalOperationLogger } from './critical-operation.logger';
import { computeFingerprint, hashIdempotencyKey } from '../idempotency/idempotency.service';

describe('CriticalOperationLogger', () => {
  let logger: CriticalOperationLogger;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new CriticalOperationLogger('Test');
    logSpy = jest.spyOn((logger as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn((logger as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('devrait logger un started sans la clé complète', () => {
    const key = 'super-secret-idempotency-key-full';
    logger.logStarted('scope', 'actor', hashIdempotencyKey(key), 'fingerprint-hash');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(msg.keyHashPrefix).toBe(hashIdempotencyKey(key).slice(0, 8));
    expect(msg.keyHashPrefix).not.toContain('secret');
    expect(JSON.stringify(msg)).not.toContain(key);
  });

  it('devrait logger un replay avec replay=true', () => {
    logger.logReplay('ticket-purchase', 'user-123', hashIdempotencyKey('key-abc'));
    const msg = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(msg.status).toBe('replay');
    expect(msg.replay).toBe(true);
  });

  it('devrait utiliser warn pour les failures', () => {
    logger.logFailed('scope', 'actor', hashIdempotencyKey('key'), 100, 'SomeError');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const msg = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(msg.status).toBe('failed');
    expect(msg.errorCode).toBe('SomeError');
  });

  it('devrait utiliser warn pour les conflicts', () => {
    logger.logConflict('scope', 'actor', hashIdempotencyKey('key'), 'already_processing');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('devrait masquer les actorId longs (ex: stripePaymentIntentId)', () => {
    const longId = 'pi_3Xyz_VERY_LONG_STRIPE_PAYMENT_INTENT_ID_SENSITIVE';
    logger.logStarted('stripe-webhook', longId, hashIdempotencyKey('key'), 'fp');
    const msg = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(msg.actorId).not.toBe(longId);
    expect(msg.actorId).toMatch(/^[0-9a-f]{12}$/);
    expect(msg.actorId.length).toBeLessThan(longId.length);
  });

  it('devrait aussi masquer les actorId courts (userId MongoDB)', () => {
    const shortId = '64abc123def456789012abcd';  // 24 chars ObjectId
    logger.logStarted('ticket-purchase', shortId, hashIdempotencyKey('key'), 'fp');
    const msg = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(msg.actorId).not.toBe(shortId);
    expect(msg.actorId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('devrait logger transaction started/committed', () => {
    logger.logTransactionStarted('ticket-purchase');
    logger.logTransactionCommitted('ticket-purchase', 42);
    expect(logSpy).toHaveBeenCalledTimes(2);
    const msg = JSON.parse(logSpy.mock.calls[1][0] as string);
    expect(msg.transactionOutcome).toBe('committed');
    expect(msg.durationMs).toBe(42);
  });

  it('devrait logger transaction rollback avec warn', () => {
    logger.logTransactionRolledBack('ticket-purchase', 10, 'BadRequestException');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(msg.transactionOutcome).toBe('rolledback');
  });
});

describe('computeFingerprint', () => {
  it('devrait produire la même valeur pour le même payload', () => {
    const fp1 = computeFingerprint({ ticketTypeId: 'abc', quantity: 2 });
    const fp2 = computeFingerprint({ ticketTypeId: 'abc', quantity: 2 });
    expect(fp1).toBe(fp2);
  });

  it('devrait produire la même valeur quelle que soit l\'ordre des clés', () => {
    const fp1 = computeFingerprint({ a: 1, b: 2 });
    const fp2 = computeFingerprint({ b: 2, a: 1 });
    expect(fp1).toBe(fp2);
  });

  it('devrait produire des valeurs différentes pour des payloads différents', () => {
    const fp1 = computeFingerprint({ ticketTypeId: 'abc', quantity: 1 });
    const fp2 = computeFingerprint({ ticketTypeId: 'abc', quantity: 5 });
    expect(fp1).not.toBe(fp2);
  });

  it('devrait produire une chaîne hex de 64 caractères (SHA-256)', () => {
    const fp = computeFingerprint({ x: 1 });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('devrait différencier les valeurs de types différents', () => {
    const fp1 = computeFingerprint({ quantity: 1 });
    const fp2 = computeFingerprint({ quantity: '1' });
    expect(fp1).not.toBe(fp2);
  });
});
