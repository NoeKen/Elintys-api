import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IdempotentOperation, IdempotentOperationSchema } from './idempotency/idempotent-operation.schema';
import { IdempotencyService } from './idempotency/idempotency.service';
import { TransactionService } from './transactions/transaction.service';

/**
 * ConsistencyModule — socle transverse d'infrastructure critique.
 *
 * Exporte :
 * - IdempotencyService : exécution idempotente multi-instance garantie par MongoDB
 * - TransactionService : wrapper explicite BEGIN/COMMIT/ROLLBACK
 *
 * Ce module NE contient PAS de logique métier.
 * Les invariants métier (sold ≤ quantity, un participant = une inscription…)
 * restent dans leurs modules respectifs.
 *
 * Pour utiliser dans un module métier :
 * ```typescript
 * @Module({ imports: [ConsistencyModule], ... })
 * export class TicketsModule {}
 * ```
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdempotentOperation.name, schema: IdempotentOperationSchema },
    ]),
  ],
  providers: [IdempotencyService, TransactionService],
  exports: [IdempotencyService, TransactionService],
})
export class ConsistencyModule {}
