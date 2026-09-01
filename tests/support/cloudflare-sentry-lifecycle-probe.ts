import assert from 'node:assert/strict';

import * as Sentry from '@sentry/cloudflare';

import { createTelemetryAdapterChain } from '@/composition/telemetry/adapter-chain';
import { createSentryTelemetryAdapter } from '@/composition/telemetry/sentry-adapter';
import { createCloudflareSentryOptions } from '@/composition/telemetry/sentry-cloudflare-options';
import {
  createNoOpTelemetry,
  setTelemetry,
  telemetryProxy,
} from '@/platform/telemetry';
import {
  initializeCloudflareSentryIsolation,
  runWithCloudflareSentry,
} from '@/runtime/cloudflare/sentry-request';
import {
  forceFlushRequestTelemetry,
  registerRequestCompletion,
} from '@/runtime/request-completion';

type RequestClient = ReturnType<typeof Sentry.getClient>;

const sentEnvelopes = new Map<string, unknown[]>();
const transportFlushCounts = new Map<string, number>();
let nativeFlushCount = 0;

const nativeTelemetry = {
  ...createNoOpTelemetry(),
  forceFlush: async () => {
    nativeFlushCount += 1;
  },
};
const sentryTelemetry = createSentryTelemetryAdapter(Sentry, {
  flushOwner: 'request-wrapper',
});
const requestTelemetry = createTelemetryAdapterChain([
  nativeTelemetry,
  sentryTelemetry,
]);

const sentryOptions = (
  label: string,
  request: Request
): Parameters<typeof Sentry.wrapRequestHandler>[0]['options'] => ({
  ...createCloudflareSentryOptions(Sentry, request, {
    SENTRY_DSN: 'https://public@example.com/1',
  }),
  release: `start-ui-web@5.0.0-${label}`,
  transport: () => ({
    flush: async () => {
      transportFlushCounts.set(
        label,
        (transportFlushCounts.get(label) ?? 0) + 1
      );
      return true;
    },
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

  assert.equal(
    await forceFlushRequestTelemetry(requestB, requestTelemetry),
    'flushed'
  );
  await Promise.allSettled(waitUntilB);
  assert.equal(requestClientB.getTransport(), undefined);
  assert.equal(transportFlushCounts.get(bLabel), 1);
  assert.ok(
    requestClientA.getTransport(),
    `${method} A client must survive B disposal`
  );

  assert.ok(resolveLateWork);
  resolveLateWork();
  assert.equal(
    await forceFlushRequestTelemetry(requestA, requestTelemetry),
    'flushed'
  );
  await Promise.allSettled(waitUntilA);

  assert.equal(requestClientA.getTransport(), undefined);
  assert.equal(transportFlushCounts.get(aLabel), 1);
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

const assertHostileParentTraceCannotExportTransaction = async () => {
  const label = 'hostile-parent';
  const request = new Request(
    'https://app.example.test/api/auth/sign-in?token=query-secret',
    {
      body: JSON.stringify({
        email: 'person@example.com',
        password: 'body-secret',
      }),
      headers: {
        authorization: 'Bearer header-secret',
        'content-type': 'application/json',
        'sentry-trace': `${'1'.repeat(32)}-${'2'.repeat(16)}-1`,
      },
      method: 'POST',
    }
  );
  const response = new Response(null, { status: 204 });
  const waitUntilCompletions: Array<Promise<unknown>> = [];
  const nativeClone = request.clone.bind(request);
  let cloneCount = 0;
  Object.defineProperty(request, 'clone', {
    configurable: true,
    value: () => {
      cloneCount += 1;
      return nativeClone();
    },
  });

  const returned = await runWithCloudflareSentry({
    api: Sentry,
    handle: async () => {
      assert.equal(
        request.bodyUsed,
        false,
        'exception-only integrations must not buffer the request body'
      );
      const integrationNames =
        Sentry.getClient()
          ?.getOptions()
          .integrations?.map((integration) => integration.name) ?? [];
      assert.deepEqual(integrationNames, ['EventFilters', 'LinkedErrors']);
      telemetryProxy.captureException(
        new Error('hostile transaction exception-secret'),
        {
          level: 'error',
          tags: { event: 'framework.stream.failed' },
        }
      );
      return response;
    },
    request,
    requestOptions: {
      captureErrors: false,
      context: {
        waitUntil(completion: Promise<unknown>) {
          waitUntilCompletions.push(Promise.resolve(completion));
        },
      } as never,
      options: sentryOptions(label, request),
      request: request as never,
    },
  });

  assert.equal(returned, response);
  assert.equal(
    cloneCount,
    0,
    'exception-only integrations must not clone or buffer the request body'
  );
  assert.equal(
    await forceFlushRequestTelemetry(request, requestTelemetry),
    'flushed'
  );
  await Promise.allSettled(waitUntilCompletions);
  assert.equal(transportFlushCounts.get(label), 1);
  const envelopes = sentEnvelopes.get(label) ?? [];
  assert.equal(
    envelopes.length,
    1,
    'the sanitized control exception must be the only exported envelope'
  );
  const envelopeText = JSON.stringify(envelopes[0]);
  assert.match(envelopeText, /framework\.stream\.failed/u);
  assert.match(envelopeText, /"method":"POST"/u);
  assert.doesNotMatch(envelopeText, /"type":"transaction"/u);
  assert.doesNotMatch(
    envelopeText,
    /body-secret|exception-secret|header-secret|query-secret|person@example\.com/u
  );
};

assert.equal(initializeCloudflareSentryIsolation(Sentry), true);
setTelemetry(requestTelemetry);

await runConcurrentDeferredScenario('HEAD');
await runConcurrentDeferredScenario('OPTIONS');
await assertHostileParentTraceCannotExportTransaction();
assert.equal(nativeFlushCount, 5);

process.stdout.write('{"cloudflareSentryLifecycle":"passed"}\n');
