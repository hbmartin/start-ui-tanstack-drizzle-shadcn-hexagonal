import assert from 'node:assert/strict';

import * as Sentry from '@sentry/cloudflare';

import { createSentryTelemetryAdapter } from '@/composition/telemetry/sentry-adapter';
import { setTelemetry, telemetryProxy } from '@/platform/telemetry';
import {
  initializeCloudflareSentryIsolation,
  runWithCloudflareSentry,
} from '@/runtime/cloudflare/sentry-request';
import {
  registerRequestCompletion,
  takeRequestCompletions,
} from '@/runtime/request-completion';

const sentEnvelopes: unknown[] = [];
const waitUntilCompletions: Array<Promise<unknown>> = [];
const request = new Request('https://app.example.test/stream');
const responseBody = new ReadableStream();
const applicationResponse = new Response(responseBody);
let triggerLateWork: (() => void) | undefined;
let lateWork: Promise<void> | undefined;
let requestClient: ReturnType<typeof Sentry.getClient>;
let captureCount = 0;

assert.equal(initializeCloudflareSentryIsolation(Sentry), true);
setTelemetry(createSentryTelemetryAdapter(Sentry));

const returned = await runWithCloudflareSentry({
  api: Sentry,
  handle: async () => {
    requestClient = Sentry.getClient();
    assert.ok(requestClient, 'request-scoped Sentry client must be installed');
    const originalCapture = requestClient.captureException.bind(requestClient);
    requestClient.captureException = (...args) => {
      captureCount += 1;
      return originalCapture(...args);
    };

    let resolveLateWork: (() => void) | undefined;
    const lateSignal = new Promise<void>((resolve) => {
      resolveLateWork = resolve;
    });
    triggerLateWork = resolveLateWork;
    lateWork = lateSignal.then(() => {
      assert.equal(
        Sentry.getClient(),
        requestClient,
        'deferred stream work must retain its request client'
      );
      assert.ok(
        requestClient?.getTransport(),
        'request client must remain active until stream completion'
      );
      telemetryProxy.captureException(new Error('late stream failure'), {
        level: 'error',
        tags: { event: 'framework.stream.failed' },
      });
      return undefined;
    });
    registerRequestCompletion(request, lateWork);
    return applicationResponse;
  },
  request,
  requestOptions: {
    captureErrors: false,
    context: {
      waitUntil(completion: Promise<unknown>) {
        waitUntilCompletions.push(Promise.resolve(completion));
      },
    } as never,
    options: {
      dsn: 'https://public@example.com/1',
      integrations: [],
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
      transport: () => ({
        flush: async () => true,
        send: async (envelope: unknown) => {
          sentEnvelopes.push(envelope);
          return { statusCode: 200 };
        },
      }),
    },
    request: request as never,
  },
});

assert.equal(returned, applicationResponse);
assert.equal(returned.body, responseBody);
assert.equal(captureCount, 0);
assert.ok(requestClient?.getTransport());
assert.ok(triggerLateWork);
triggerLateWork();
await lateWork;
await Promise.allSettled(takeRequestCompletions(request));
await Promise.allSettled(waitUntilCompletions);

assert.equal(captureCount, 1);
assert.equal(requestClient?.getTransport(), undefined);
assert.ok(
  sentEnvelopes.some((envelope) =>
    JSON.stringify(envelope).includes('framework.stream.failed')
  ),
  'late stream exception must be exported through the request client'
);
process.stdout.write('{"cloudflareSentryLifecycle":"passed"}\n');
