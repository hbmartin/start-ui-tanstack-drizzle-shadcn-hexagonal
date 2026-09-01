import {
  createHyperdriveDbClient,
  runWithRuntimeDatabaseClient,
  validateServerConfig,
} from '@/modules/kernel/backend';
import { reportTelemetryFailure, telemetryProxy } from '@/platform/telemetry';

type CloudflareRequestDatabase = Awaited<
  ReturnType<typeof createHyperdriveDbClient>
>;

const closeDatabase = async (database: CloudflareRequestDatabase) => {
  try {
    await database.$close();
  } catch (failure) {
    reportTelemetryFailure('database.cloudflare.close', failure);
  }
};

const captureDatabaseConnectionFailure = (failure: unknown) => {
  telemetryProxy.emitLog({
    direction: 'internal',
    event: 'database.cloudflare.connect_failed',
    exception: failure,
    level: 'error',
  });
  telemetryProxy.captureException(failure, {
    level: 'error',
    tags: { event: 'database.cloudflare.connect_failed' },
  });
};

/**
 * Keeps the request-owned database alive for deferred response production.
 * The identity transform preserves backpressure and propagates EOF, producer
 * errors, and consumer cancellation without cloning or eagerly buffering the
 * application body.
 */
export const bindCloudflareDatabaseToResponse = ({
  database,
  request,
  response,
}: {
  database: CloudflareRequestDatabase;
  request: Request;
  response: Response;
}): Response => {
  if (!response.body) {
    void closeDatabase(database);
    return response;
  }
  if (response.bodyUsed || response.body.locked) {
    throw new TypeError(
      'Cloudflare response body must be unused and unlocked before database binding'
    );
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const completion = response.body
    .pipeTo(writable, { signal: request.signal })
    .catch(() => undefined)
    .then(() => closeDatabase(database));
  // Response production owns this completion. It must not enter the telemetry
  // pre-flush set: a slow client may hold the body open longer than the bounded
  // exporter deadline, but logs and metrics still need to flush promptly.
  void completion;

  return new Response(readable, response);
};

/**
 * Owns one Hyperdrive client for one Cloudflare request. The outer entrypoint
 * establishes Sentry isolation first; adapter validation, application work,
 * and deferred stream production then execute inside the strict database
 * AsyncLocalStorage scope.
 */
export const runWithCloudflareDatabase = async ({
  binding,
  handle,
  request,
}: {
  binding: unknown;
  handle: () => Promise<Response> | Response;
  request: Request;
}): Promise<Response> => {
  let database: CloudflareRequestDatabase;
  try {
    database = await createHyperdriveDbClient(binding);
  } catch (failure) {
    captureDatabaseConnectionFailure(failure);
    throw failure;
  }

  return runWithRuntimeDatabaseClient(database, async () => {
    try {
      validateServerConfig('cloudflare', {
        databaseAdapter: database.$adapter,
      });
      const response = await handle();
      return bindCloudflareDatabaseToResponse({
        database,
        request,
        response,
      });
    } catch (failure) {
      await closeDatabase(database);
      throw failure;
    }
  });
};
