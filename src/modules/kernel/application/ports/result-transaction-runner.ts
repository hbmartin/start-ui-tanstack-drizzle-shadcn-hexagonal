import type { ApplicationResult } from '../result';
import type { TransactionOptions } from './transaction-runner';

/**
 * Application-facing transaction boundary. Returning Result.Error always
 * rolls the physical transaction back before the same AppError is returned.
 */
export interface ResultTransactionRunner<TContext> {
  run<TOutcome extends { type: string }>(
    work: (context: TContext) => Promise<ApplicationResult<TOutcome>>,
    options?: TransactionOptions
  ): Promise<ApplicationResult<TOutcome>>;
}
