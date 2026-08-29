import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection } from 'mongoose';
import { CriticalOperationLogger } from '../observability/critical-operation.logger';

/**
 * Wrapper léger autour de Mongoose Connection#transaction.
 *
 * Principe : rendre BEGIN / COMMIT / ROLLBACK explicitement visible
 * sans cacher la logique métier derrière une abstraction magique.
 *
 * La session est gérée par Mongoose (startSession + withTransaction + endSession).
 * Le code appelant doit passer la session à chaque opération Mongoose :
 *
 * ```typescript
 * const result = await transactionService.run('ticket-purchase', async (session) => {
 *   const tt = await TicketType.findOneAndUpdate(
 *     { _id: id, sold: { $lt: quantity } },
 *     { $inc: { sold: quantity } },
 *     { session, new: true }
 *   );
 *   if (!tt) throw new InsufficientCapacityError();
 *   const purchase = await TicketPurchase.create([{ ... }], { session });
 *   return purchase;
 * });
 * ```
 *
 * IMPORTANT : Ne jamais utiliser Promise.all() dans une transaction —
 * MongoDB ne garantit pas l'ordre d'exécution des opérations parallèles
 * dans la même session.
 */
@Injectable()
export class TransactionService {
  private readonly logger = new CriticalOperationLogger('TransactionService');

  constructor(
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async run<T>(scope: string, work: (session: ClientSession) => Promise<T>): Promise<T> {
    this.logger.logTransactionStarted(scope);
    const start = Date.now();

    try {
      const result = await this.connection.transaction(work, {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      this.logger.logTransactionCommitted(scope, Date.now() - start);
      return result;
    } catch (err: unknown) {
      const errorCode = err instanceof Error ? err.constructor.name : 'UNKNOWN_ERROR';
      this.logger.logTransactionRolledBack(scope, Date.now() - start, errorCode);
      throw err;
    }
  }
}
