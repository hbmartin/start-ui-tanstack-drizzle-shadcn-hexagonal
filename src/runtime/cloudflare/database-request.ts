import {
  createHyperdriveDbClient,
  runWithRuntimeDatabaseClient,
  validateServerConfig,
} from '@/modules/kernel/backend';
import { reportTelemetryFailure } from '@/platform/telemetry';

import { registerRequestCompletion } from '../request-completion';

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
    registerRequestCompletion(request, closeDatabase(database));
    return response;
  }
  if (response.bodyUsed || response.body.locked) {
    throw new TypeError(
      'Cloudflare response body must be unused and unlocked before database binding'
    );
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const completion = response.body
    .pipeTo(writable)
    .catch(() => undefined)
    .then(() => closeDatabase(database));
  registerRequestCompletion(request, completion);

  return new Response(readable, response);
};

/**
 * Owns one Hyperdrive client for one Cloudflare request. Adapter validation,
 * Sentry request isolation, the application handler, and deferred stream
 * production all execute inside the strict database AsyncLocalStorage scope.
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
  const database = await createHyperdriveDbClient(binding);

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
