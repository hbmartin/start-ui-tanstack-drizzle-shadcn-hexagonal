import * as Sentry from '@sentry/tanstackstart-react';
import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserSentryOptions } from '@/composition/telemetry/sentry.client';

afterEach(async () => {
  await Sentry.close(2_000);
});

describe('browser Sentry exception ownership', () => {
  it('exports only sanitized exceptions without session envelopes', async () => {
    const envelopes: unknown[] = [];
    Sentry.init({
      ...createBrowserSentryOptions(),
      dsn: 'https://public@example.com/1',
      transport: () => ({
        flush: async () => true,
        send: async (envelope: unknown) => {
          envelopes.push(envelope);
          return { statusCode: 200 };
        },
      }),
    });

    const client = Sentry.getClient();
    expect(client).toBeDefined();
    expect(client!.getOptions()).not.toHaveProperty('tracesSampleRate');
    expect(client!.getOptions()).not.toHaveProperty('tracesSampler');
    const integrationNames = client!
      .getOptions()
      .integrations!.map((integration) => integration.name);
    expect(integrationNames).toEqual([
      'EventFilters',
      'FunctionToString',
      'BrowserApiErrors',
      'GlobalHandlers',
      'LinkedErrors',
    ]);
    expect(window.onerror).toHaveProperty('__SENTRY_INSTRUMENTED__', true);
    expect(window.onunhandledrejection).toHaveProperty(
      '__SENTRY_INSTRUMENTED__',
      true
    );

    Sentry.setUser({ id: 'browser-user-secret' });
    Sentry.captureException(new Error('browser-exception-secret'));
    const captureRepeatedFailure = () =>
      Sentry.captureException(new Error('repeated-exception-secret'));
    captureRepeatedFailure();
    captureRepeatedFailure();
    const installedOnError = window.onerror;
    const installedOnUnhandledRejection = window.onunhandledrejection;
    expect(installedOnError).toBeTypeOf('function');
    expect(installedOnUnhandledRejection).toBeTypeOf('function');
    installedOnError!.call(
      window,
      'global-error-secret',
      'https://app.example.test/account?token=query-secret',
      1,
      2,
      new Error('global-error-secret')
    );
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', {
      value: new Error('global-rejection-secret'),
    });
    installedOnUnhandledRejection!.call(
      window,
      rejection as PromiseRejectionEvent
    );
    await expect(Sentry.flush(2_000)).resolves.toBe(true);

    expect(envelopes).toHaveLength(5);
    const envelopeText = JSON.stringify(envelopes);
    expect(envelopeText).not.toMatch(
      /browser-exception-secret|browser-user-secret|global-error-secret|global-rejection-secret|query-secret|repeated-exception-secret|"type":"session"|"type":"transaction"/u
    );
    expect(envelopeText.match(/Unexpected application error/gu)).toHaveLength(
      5
    );
  });
});
