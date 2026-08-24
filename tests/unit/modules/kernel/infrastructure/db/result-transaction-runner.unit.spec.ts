import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';

import type { ApplicationResult, TransactionRunner } from '@/modules/kernel';
import { AppError } from '@/modules/kernel';
import { createResultTransactionRunner } from '@/modules/kernel/backend';

const appError = new AppError({
  code: 'WORK_FAILED',
  category: 'system',
  status: 500,
});

const getOk = <TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) => {
  if (result.isError()) throw result.getError();
  return result.get();
};

const getError = <TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) => {
  if (result.isOk())
    throw new Error(`Expected error, got ${result.get().type}`);
  return result.getError();
};

describe('result transaction runner', () => {
  it('returns successful work and forwards transaction options', async () => {
    const context = { value: 'bound' };
    const transaction = { id: 'tx-1' };
    const lowLevel: TransactionRunner<typeof transaction> = {
      run: vi.fn(async (work) => work(transaction)),
    };
    const bindContext = vi.fn(() => context);
    const runner = createResultTransactionRunner({
      transactionRunner: lowLevel,
      bindContext,
    });
    const options = { isolationLevel: 'serializable' as const };

    const result = await runner.run(
      async (bound) => Result.Ok({ type: 'worked' as const, bound }),
      options
    );

    expect(getOk(result)).toEqual({ type: 'worked', bound: context });
    expect(bindContext).toHaveBeenCalledOnce();
    expect(lowLevel.run).toHaveBeenCalledWith(expect.any(Function), options);
  });

  it('forces rollback and returns the same AppError when work returns an error', async () => {
    let rollbackObserved = false;
    const lowLevel: TransactionRunner<{ id: string }> = {
      async run(work) {
        try {
          return await work({ id: 'tx-1' });
        } catch (error) {
          rollbackObserved = true;
          throw error;
        }
      },
    };
    const runner = createResultTransactionRunner({
      transactionRunner: lowLevel,
      bindContext: (transaction) => transaction,
    });

    const result = await runner.run(async () => Result.Error(appError));

    expect(getError(result)).toBe(appError);
    expect(rollbackObserved).toBe(true);
  });

  it('maps unexpected transaction exceptions without leaking their message', async () => {
    const lowLevel: TransactionRunner<{ id: string }> = {
      async run() {
        throw new Error('provider secret detail');
      },
    };
    const runner = createResultTransactionRunner({
      transactionRunner: lowLevel,
      bindContext: (transaction) => transaction,
    });

    const result = await runner.run(async () =>
      Result.Ok({ type: 'unreachable' as const })
    );

    expect(getError(result)).toMatchObject({
      code: 'TRANSACTION_FAILED',
      message: 'Transaction failed',
    });
  });
});
