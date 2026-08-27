import { reportTelemetryFailure, telemetryProxy } from '@/platform/telemetry';

export type DatabaseClientErrorHandler = (error: unknown) => void;

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
    }
  };
