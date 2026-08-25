import { reportTelemetryFailure } from '@/platform/telemetry';

import {
  registerRequestCompletion,
  snapshotRequestCompletions,
} from '../request-completion';

type CloudflareSentryRequestApi = Pick<
  typeof import('@sentry/cloudflare'),
  'wrapRequestHandler'
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
 * Gives Sentry a request-isolated client without letting its streaming wrapper
 * consume or replace the application's Response/body. The wrapper sees only a
 * bodyless sentinel; the original application outcome is returned verbatim.
 */
export const runWithCloudflareSentry = async ({
  api,
  handle,
  request,
  requestOptions,
}: {
  api: CloudflareSentryRequestApi;
  handle: () => Promise<Response> | Response;
  request: Request;
  requestOptions: RequestHandlerOptions;
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
    const sentryResponse = await api.wrapRequestHandler(
      requestOptions,
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
  applicationOutcome = await runApplicationOnce();
  if (applicationOutcome.type === 'failed') {
    throw applicationOutcome.failure;
  }
  return applicationOutcome.response;
};
