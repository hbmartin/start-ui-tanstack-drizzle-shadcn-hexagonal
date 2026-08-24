import { Result } from '@bloodyowl/boxed';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError, type ApplicationResult } from '@/modules/kernel';
import {
  createResultTransactionRunner,
  createTransactionRunner,
} from '@/modules/kernel/backend';
import { genre as genreTable } from '@/modules/kernel/infrastructure/db/schema';

const getError = <TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) => {
  if (result.isOk())
    throw new Error(`Expected error, got ${result.get().type}`);
  return result.getError();
};

describe('result transaction runner integration', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
  });

  beforeEach(async () => {
    await database.truncate();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('rolls back writes when application work resolves to Result.Error', async () => {
    const expectedError = new AppError({
      code: 'EXPECTED_WORK_FAILURE',
      category: 'system',
      status: 500,
    });
    const runner = createResultTransactionRunner({
      transactionRunner: createTransactionRunner(database.db),
      bindContext: (transaction) => transaction,
    });

    const result = await runner.run(async (transaction) => {
      await transaction.insert(genreTable).values({
        id: 'genre-rollback',
        name: 'Rolled Back',
        color: '#112233',
      });
      return Result.Error(expectedError);
    });

    expect(getError(result)).toBe(expectedError);
    await expect(database.db.select().from(genreTable)).resolves.toEqual([]);
  });
});
