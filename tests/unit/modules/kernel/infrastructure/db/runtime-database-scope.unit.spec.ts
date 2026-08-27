import { describe, expect, it } from 'vitest';

import type { Database } from '@/modules/kernel/infrastructure/db/types';
import {
  getRuntimeDatabaseClient,
  runWithRuntimeDatabaseClient,
} from '@/modules/kernel/infrastructure/db/runtime-database-scope';

describe('runtime database request scope', () => {
  it('restores the parent adapter after a nested operation', () => {
    const outer = { marker: 'outer' } as unknown as Database;
    const inner = { marker: 'inner' } as unknown as Database;

    expect(getRuntimeDatabaseClient()).toBeUndefined();
    runWithRuntimeDatabaseClient(outer, () => {
      expect(getRuntimeDatabaseClient()).toBe(outer);
      runWithRuntimeDatabaseClient(inner, () => {
        expect(getRuntimeDatabaseClient()).toBe(inner);
      });
      expect(getRuntimeDatabaseClient()).toBe(outer);
    });
    expect(getRuntimeDatabaseClient()).toBeUndefined();
  });

  it('preserves the adapter through asynchronous work', async () => {
    const database = { marker: 'async' } as unknown as Database;

    await runWithRuntimeDatabaseClient(database, async () => {
      await Promise.resolve();
      expect(getRuntimeDatabaseClient()).toBe(database);
    });
    expect(getRuntimeDatabaseClient()).toBeUndefined();
  });
});
