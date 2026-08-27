import { AsyncLocalStorage } from 'node:async_hooks';

import type { Database } from './types';

const runtimeDatabaseStorage = new AsyncLocalStorage<Database>();

export const getRuntimeDatabaseClient = (): Database | undefined =>
  runtimeDatabaseStorage.getStore();

export const runWithRuntimeDatabaseClient = <T>(
  database: Database,
  operation: () => T
): T => runtimeDatabaseStorage.run(database, operation);
