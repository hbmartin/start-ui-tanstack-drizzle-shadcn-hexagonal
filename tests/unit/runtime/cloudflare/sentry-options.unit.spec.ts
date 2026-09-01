import { describe, expect, it } from 'vitest';

import { createCloudflareSentryOptions } from '@/composition/telemetry/sentry-cloudflare-options';

const integrationApi = {
  eventFiltersIntegration: () => ({ name: 'EventFilters' }),
  linkedErrorsIntegration: () => ({ name: 'LinkedErrors' }),
} as never;

describe('Cloudflare Sentry options', () => {
  it('leaves Sentry tracing disabled while dropping transactions defensively', () => {
    const options = createCloudflareSentryOptions(
      integrationApi,
      new Request('https://app.example.test/account'),
      { SENTRY_DSN: 'https://public@example.com/1' }
    );

    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options).not.toHaveProperty('tracesSampler');
    expect(options.defaultIntegrations).toBe(false);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.integrations).toEqual([
      { name: 'EventFilters' },
      { name: 'LinkedErrors' },
    ]);
    expect(
      options.beforeSendTransaction?.({} as never, {} as never)
    ).toBeNull();
  });

  it('projects hostile error request data onto the original method only', () => {
    const request = new Request(
      'https://app.example.test/account?token=query-secret',
      { method: 'POST' }
    );
    const options = createCloudflareSentryOptions(integrationApi, request, {
      SENTRY_DSN: 'https://public@example.com/1',
    });
    const sanitized = options.beforeSend?.(
      {
        message: 'Bearer message-secret for person@example.com',
        request: {
          data: '{"password":"body-secret"}',
          headers: { authorization: 'Bearer header-secret' },
          method: 'GET',
          query_string: 'token=query-secret',
          url: request.url,
        },
      } as never,
      {} as never
    );

    expect(sanitized).toEqual({
      message: 'Unexpected application error',
      request: { method: 'POST' },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /body-secret|header-secret|message-secret|query-secret|person@example\.com/u
    );
  });
});
