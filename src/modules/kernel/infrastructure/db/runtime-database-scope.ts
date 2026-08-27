import { AsyncLocalStorage } from 'node:async_hooks';

import type { Database } from './types';

const runtimeDatabaseStorage = new AsyncLocalStorage<Database>();
let runtimeDatabaseRequired = false;

export const requireRuntimeDatabaseClient = (): void => {
  runtimeDatabaseRequired = true;
};

export const isRuntimeDatabaseClientRequired = (): boolean =>
  runtimeDatabaseRequired;

export const getRuntimeDatabaseClient = (): Database | undefined =>
  runtimeDatabaseStorage.getStore();

export const runWithRuntimeDatabaseClient = <T>(
  database: Database,
  operation: () => T
): T => {
  requireRuntimeDatabaseClient();
  return runtimeDatabaseStorage.run(database, operation);
};
