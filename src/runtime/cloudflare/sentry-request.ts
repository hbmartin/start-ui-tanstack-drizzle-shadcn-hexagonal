import { reportTelemetryFailure } from '@/platform/telemetry';

import {
  registerRequestCompletion,
  snapshotRequestCompletions,
} from '../request-completion';

type CloudflareSentryRequestApi = Pick<
  typeof import('@sentry/cloudflare'),
  'withScope' | 'wrapRequestHandler'
>;
type CloudflareSentryIsolationApi = Pick<
  typeof import('@sentry/cloudflare'),
  'setAsyncLocalStorageAsyncContextStrategy'
>;

type RequestHandlerOptions = Parameters<
  CloudflareSentryRequestApi['wrapRequestHandler']
>[0];

type ApplicationOutcome =
  | { type: 'failed'; failure: unknown }
  | { type: 'responded'; response: Response };

const sentrySentinelResponse = (applicationCompletion: Promise<unknown>) =>
  new Response(
    new ReadableStream({
      start(controller) {
        void applicationCompletion.then(
          () => controller.close(),
          () => controller.close()
        );
      },
    }),
    {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      status: 200,
    }
  );

/**
 * `wrapRequestHandler` assumes the Cloudflare SDK async-context strategy has
 * already been installed (normally `withSentry` does this). This entrypoint
 * calls the lower-level wrapper so it must establish the strategy exactly once
 * before accepting requests. Failure disables Sentry instead of sharing its
 * fallback isolation scope across concurrent requests.
 */
export const initializeCloudflareSentryIsolation = (
  api: CloudflareSentryIsolationApi
): boolean => {
  try {
    api.setAsyncLocalStorageAsyncContextStrategy();
    return true;
  } catch (failure) {
    reportTelemetryFailure('sentry.cloudflare.async_context', failure);
    return false;
  }
};

/**
 * Enforces the import boundary: request isolation is installed before any
 * application/TanStack module supplied by `loadApplication` is evaluated.
 * The SDK itself requires the verified Worker `nodejs_compat` flag so that its
 * static `node:async_hooks` import can load before this function is reached.
 */
export const initializeCloudflareSentryApplication = async <TApplication>(
  api: CloudflareSentryIsolationApi,
  loadApplication: () => Promise<TApplication>
): Promise<{
  application: TApplication;
  sentryRequestIsolationReady: boolean;
}> => {
  const sentryRequestIsolationReady = initializeCloudflareSentryIsolation(api);
  const application = await loadApplication();
  return { application, sentryRequestIsolationReady };
};

const sentryLifecycleRequest = (request: Request): Request => {
  if (request.method !== 'HEAD' && request.method !== 'OPTIONS') return request;

  // The SDK disposes its client immediately for HEAD/OPTIONS instead of
  // waiting for the response body. A bodyless GET is used only by Sentry's
  // lifecycle wrapper; the application still receives the original request.
  return new Request(request.url, {
    headers: request.headers,
    method: 'GET',
  });
};

/**
 * Gives Sentry a request-isolated client without letting its streaming wrapper
 * consume or replace the application's Response/body. The wrapper sees only a
 * bodyless sentinel; the original application outcome is returned verbatim.
 */
export const runWithCloudflareSentry = async ({
  api,
  handle,
  request,
  requestOptions,
  requireSentryOwner = false,
}: {
  api: CloudflareSentryRequestApi;
  handle: () => Promise<Response> | Response;
  request: Request;
  requestOptions: RequestHandlerOptions;
  requireSentryOwner?: boolean;
}): Promise<Response> => {
  let applicationOutcome: ApplicationOutcome | undefined;
  let applicationWork: Promise<ApplicationOutcome> | undefined;
  const runApplicationOnce = () => {
    applicationWork ??= Promise.resolve().then(async () => {
      try {
        return {
          response: await handle(),
          type: 'responded',
        } satisfies ApplicationOutcome;
      } catch (failure) {
        return { failure, type: 'failed' } satisfies ApplicationOutcome;
      }
    });
    return applicationWork;
  };

  try {
    const sentryResponse = await api.withScope(() =>
      api.wrapRequestHandler(
        {
          ...requestOptions,
          request: sentryLifecycleRequest(request) as never,
        },
        async () => {
          applicationOutcome = await runApplicationOnce();
          if (applicationOutcome.type === 'failed') {
            throw applicationOutcome.failure;
          }
          const applicationCompletion = Promise.allSettled(
            snapshotRequestCompletions(request)
          );
          return sentrySentinelResponse(applicationCompletion);
        }
      )
    );
    if (sentryResponse.body) {
      const sentryCompletion = sentryResponse
        .arrayBuffer()
        .then(() => undefined)
        .catch((failure: unknown) => {
          reportTelemetryFailure('sentry.cloudflare.request_stream', failure);
        });
      registerRequestCompletion(request, sentryCompletion);
    }
  } catch (failure) {
    if (applicationOutcome?.type === 'failed') {
      throw applicationOutcome.failure;
    }
    reportTelemetryFailure('sentry.cloudflare.request', failure);
    if (requireSentryOwner && applicationWork === undefined) throw failure;
  }

  if (applicationOutcome?.type === 'responded') {
    return applicationOutcome.response;
  }
  if (applicationOutcome?.type === 'failed') {
    throw applicationOutcome.failure;
  }

  reportTelemetryFailure(
    'sentry.cloudflare.request',
    new Error('Sentry request wrapper skipped application handler')
  );
  if (requireSentryOwner && applicationWork === undefined) {
    throw new Error(
      'Required Sentry request owner skipped application handler'
    );
  }
  applicationOutcome = await runApplicationOnce();
  if (applicationOutcome.type === 'failed') {
    throw applicationOutcome.failure;
  }
  return applicationOutcome.response;
};
