import { Result } from '@bloodyowl/boxed';

import type { ResultTransactionRunner } from '../../application/ports/result-transaction-runner';
import type { TransactionRunner } from '../../application/ports/transaction-runner';
import { AppError } from '../../domain/errors/app-error';

class ResultTransactionRollback extends Error {
  constructor(readonly appError: AppError) {
    super('Result transaction requested rollback');
    this.name = 'ResultTransactionRollback';
  }
}

const transactionFailure = (cause: unknown) =>
  new AppError({
    code: 'TRANSACTION_FAILED',
    category: 'system',
    status: 500,
    message: 'Transaction failed',
    cause,
  });

export const createResultTransactionRunner = <TTransaction, TContext>(input: {
  bindContext: (transaction: TTransaction) => TContext;
  transactionRunner: TransactionRunner<TTransaction>;
}): ResultTransactionRunner<TContext> => ({
  async run(work, options) {
    try {
      return await input.transactionRunner.run(async (transaction) => {
        const result = await work(input.bindContext(transaction));
        if (result.isError()) {
          throw new ResultTransactionRollback(result.getError());
        }
        return result;
      }, options);
    } catch (error) {
      return Result.Error(
        error instanceof ResultTransactionRollback
          ? error.appError
          : transactionFailure(error)
      );
    }
  },
});
