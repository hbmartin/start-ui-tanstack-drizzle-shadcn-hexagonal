import { reportTelemetryFailure, telemetryProxy } from '@/platform/telemetry';

export type DatabaseClientErrorHandler = (error: unknown) => void;

type ErrorEventClient = {
  on(eventName: 'error', handler: DatabaseClientErrorHandler): unknown;
};

type ErrorEventPool = {
  on(
    eventName: 'connect',
    handler: (client: ErrorEventClient) => void
  ): unknown;
  on(eventName: 'error', handler: DatabaseClientErrorHandler): unknown;
};

const captureDatabaseClientError = (source: string, error: unknown): void => {
  telemetryProxy.captureException(error, {
    level: 'error',
    tags: { event: source },
  });
};

export const createDatabaseClientErrorHandler =
  (
    source: string,
    onError?: DatabaseClientErrorHandler
  ): DatabaseClientErrorHandler =>
  (error) => {
    try {
      (onError ?? ((failure) => captureDatabaseClientError(source, failure)))(
        error
      );
    } catch (handlerFailure) {
      reportTelemetryFailure('database.client.error_handler', handlerFailure);
      captureDatabaseClientError(source, error);
    }
  };

/**
 * pg pools remove their idle-client listener while a transaction owns the
 * physical client. Keep one diagnostic listener attached to every connection;
 * the pool-level listener is containment-only so an idle failure is captured
 * once by the physical client listener and never rethrown by EventEmitter.
 */
export const attachDatabasePoolErrorHandlers = (
  pool: ErrorEventPool,
  source: string,
  onError?: DatabaseClientErrorHandler
): void => {
  const handleClientError = createDatabaseClientErrorHandler(source, onError);
  pool.on('connect', (client) => {
    client.on('error', handleClientError);
  });
  pool.on('error', () => undefined);
};
