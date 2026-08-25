import assert from 'node:assert/strict';

import * as Sentry from '@sentry/cloudflare';

import {
  createSentryTelemetryAdapter,
  sanitizeSentryEvent,
} from '@/composition/telemetry/sentry-adapter';
import { setTelemetry, telemetryProxy } from '@/platform/telemetry';
import {
  initializeCloudflareSentryIsolation,
  runWithCloudflareSentry,
} from '@/runtime/cloudflare/sentry-request';
import {
  registerRequestCompletion,
  takeRequestCompletions,
} from '@/runtime/request-completion';

type RequestClient = ReturnType<typeof Sentry.getClient>;

const sentEnvelopes = new Map<string, unknown[]>();

const sentryOptions = (
  label: string,
  request: Request
): Parameters<typeof Sentry.wrapRequestHandler>[0]['options'] => ({
  beforeSend: (event) =>
    sanitizeSentryEvent({
      ...event,
      request: { method: request.method },
    }),
  dsn: 'https://public@example.com/1',
  integrations: [],
  release: `start-ui-web@5.0.0-${label}`,
  sendDefaultPii: false,
  skipOpenTelemetrySetup: true,
  tracesSampleRate: 0,
  transport: () => ({
    flush: async () => true,
    send: async (envelope: unknown) => {
      const envelopes = sentEnvelopes.get(label) ?? [];
      envelopes.push(envelope);
      sentEnvelopes.set(label, envelopes);
      return { statusCode: 200 };
    },
  }),
});

const runConcurrentDeferredScenario = async (method: 'HEAD' | 'OPTIONS') => {
  const suffix = method.toLowerCase();
  const aLabel = `a-${suffix}`;
  const bLabel = `b-${suffix}`;
  const requestA = new Request(`https://app.example.test/${aLabel}`, {
    method,
  });
  const requestB = new Request(`https://app.example.test/${bLabel}`, {
    method: method === 'HEAD' ? 'OPTIONS' : 'HEAD',
  });
  const responseBodyA = new ReadableStream();
  const responseBodyB = new ReadableStream();
  const responseA = new Response(responseBodyA);
  const responseB = new Response(responseBodyB);
  const waitUntilA: Array<Promise<unknown>> = [];
  const waitUntilB: Array<Promise<unknown>> = [];
  let requestClientA: RequestClient;
  let requestClientB: RequestClient;
  let resolveLateWork: (() => void) | undefined;
  const lateSignal = new Promise<void>((resolve) => {
    resolveLateWork = resolve;
  });

  const workA = runWithCloudflareSentry({
    api: Sentry,
    handle: async () => {
      requestClientA = Sentry.getClient();
      assert.ok(requestClientA, `${method} A must install a request client`);
      const lateWork = lateSignal.then(() => {
        assert.equal(
          Sentry.getClient(),
          requestClientA,
          `${method} deferred work must retain A's request client`
        );
        assert.ok(
          requestClientA?.getTransport(),
          `${method} A client must remain active through deferred work`
        );
        telemetryProxy.captureException(
          new Error(`late ${method} stream failure`),
          {
            level: 'error',
            tags: { event: 'framework.stream.failed' },
          }
        );
        return undefined;
      });
      registerRequestCompletion(requestA, lateWork);
      return responseA;
    },
    request: requestA,
    requestOptions: {
      captureErrors: false,
      context: {
        waitUntil(completion: Promise<unknown>) {
          waitUntilA.push(Promise.resolve(completion));
        },
      } as never,
      options: sentryOptions(aLabel, requestA),
      request: requestA as never,
    },
  });

  const workB = runWithCloudflareSentry({
    api: Sentry,
    handle: async () => {
      requestClientB = Sentry.getClient();
      assert.ok(requestClientB, `${method} B must install a request client`);
      return responseB;
    },
    request: requestB,
    requestOptions: {
      captureErrors: false,
      context: {
        waitUntil(completion: Promise<unknown>) {
          waitUntilB.push(Promise.resolve(completion));
        },
      } as never,
      options: sentryOptions(bLabel, requestB),
      request: requestB as never,
    },
  });

  const [returnedA, returnedB] = await Promise.all([workA, workB]);
  assert.equal(returnedA, responseA);
  assert.equal(returnedA.body, responseBodyA);
  assert.equal(returnedB, responseB);
  assert.equal(returnedB.body, responseBodyB);
  assert.ok(requestClientA);
  assert.ok(requestClientB);
  assert.notEqual(
    requestClientA,
    requestClientB,
    'concurrent requests must not share the current Sentry scope client'
  );

  await Promise.allSettled(takeRequestCompletions(requestB));
  await Promise.allSettled(waitUntilB);
  assert.equal(requestClientB.getTransport(), undefined);
  assert.ok(
    requestClientA.getTransport(),
    `${method} A client must survive B disposal`
  );

  assert.ok(resolveLateWork);
  resolveLateWork();
  await Promise.allSettled(takeRequestCompletions(requestA));
  await Promise.allSettled(waitUntilA);

  assert.equal(requestClientA.getTransport(), undefined);
  assert.equal(sentEnvelopes.get(bLabel)?.length ?? 0, 0);
  const envelopesA = sentEnvelopes.get(aLabel) ?? [];
  assert.equal(envelopesA.length, 1);
  const envelopeText = JSON.stringify(envelopesA[0]);
  assert.match(envelopeText, /framework\.stream\.failed/u);
  assert.ok(
    envelopeText.includes(`"method":"${method}"`),
    `${method} must remain the sanitized event method`
  );
};

assert.equal(initializeCloudflareSentryIsolation(Sentry), true);
setTelemetry(createSentryTelemetryAdapter(Sentry));

await runConcurrentDeferredScenario('HEAD');
await runConcurrentDeferredScenario('OPTIONS');

process.stdout.write('{"cloudflareSentryLifecycle":"passed"}\n');
