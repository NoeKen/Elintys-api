/**
 * Tests unitaires de TransactionService.
 *
 * Aucune connexion MongoDB réelle. La Connection est mockée pour simuler
 * commit et rollback de manière déterministe.
 */
import { TransactionService } from './transaction.service';
import { Connection, ClientSession } from 'mongoose';

function makeFakeSession(): jest.Mocked<Partial<ClientSession>> {
  return {};
}

function makeService(transactionImpl: (fn: (s: ClientSession) => Promise<unknown>) => Promise<unknown>): TransactionService {
  const fakeConnection = {
    transaction: jest.fn().mockImplementation(transactionImpl),
  } as unknown as Connection;

  return new TransactionService(fakeConnection);
}

describe('TransactionService', () => {
  // -------------------------------------------------------------------------
  // 8. Transaction commit
  // -------------------------------------------------------------------------
  describe('8. transaction commit', () => {
    it('devrait exécuter le work et retourner le résultat', async () => {
      const session = makeFakeSession() as unknown as ClientSession;
      const service = makeService(async (fn) => fn(session));

      const result = await service.run('ticket-purchase', async (s) => {
        expect(s).toBe(session);
        return 'committed-result';
      });

      expect(result).toBe('committed-result');
    });

    it('devrait passer la session au callback', async () => {
      const session = makeFakeSession() as unknown as ClientSession;
      const service = makeService(async (fn) => fn(session));
      const work = jest.fn().mockResolvedValue('ok');

      await service.run('test-scope', work);

      expect(work).toHaveBeenCalledWith(session);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Transaction rollback
  // -------------------------------------------------------------------------
  describe('9. transaction rollback', () => {
    it('devrait propager l\'erreur si le work échoue', async () => {
      const service = makeService(async (fn) => {
        // Simule MongoDB rollback : l'erreur remonte directement
        await fn({} as ClientSession);
      });

      await expect(
        service.run('ticket-purchase', async () => {
          throw new Error('stock insuffisant');
        }),
      ).rejects.toThrow('stock insuffisant');
    });

    it('devrait propager des erreurs NestJS (BadRequestException)', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      const service = makeService(async (fn) => {
        await fn({} as ClientSession);
      });

      await expect(
        service.run('test', async () => {
          throw new BadRequestException('INSUFFICIENT_CAPACITY');
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // Promise.all dans une transaction — comportement documenté
  // -------------------------------------------------------------------------
  describe('séquentialité dans une transaction', () => {
    it('devrait exécuter les opérations dans l\'ordre (pas de Promise.all)', async () => {
      const log: string[] = [];
      const session = {} as ClientSession;
      const service = makeService(async (fn) => fn(session));

      await service.run('ordered-ops', async (s) => {
        log.push('op-1');
        await Promise.resolve();  // simulate async op
        log.push('op-2');
        await Promise.resolve();
        log.push('op-3');
        return { s };
      });

      expect(log).toEqual(['op-1', 'op-2', 'op-3']);
    });
  });

  // -------------------------------------------------------------------------
  // Scope passé au logger
  // -------------------------------------------------------------------------
  describe('scope', () => {
    it('devrait accepter différents scopes sans erreur', async () => {
      const service = makeService(async (fn) => fn({} as ClientSession));

      await expect(service.run('stripe-webhook', async () => 'ok')).resolves.toBe('ok');
      await expect(service.run('event-registration', async () => 'ok')).resolves.toBe('ok');
    });
  });
});
