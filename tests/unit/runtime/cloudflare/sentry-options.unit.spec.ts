import { describe, expect, it } from 'vitest';

import { createCloudflareSentryOptions } from '@/composition/telemetry/sentry-cloudflare-options';

describe('Cloudflare Sentry options', () => {
  it('rejects every trace while dropping transactions defensively', () => {
    const options = createCloudflareSentryOptions(
      new Request('https://app.example.test/account'),
      { SENTRY_DSN: 'https://public@example.com/1' }
    );

    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options.tracesSampler?.({} as never)).toBe(0);
    expect(
      options.beforeSendTransaction?.({} as never, {} as never)
    ).toBeNull();
  });

  it('projects hostile error request data onto the original method only', () => {
    const request = new Request(
      'https://app.example.test/account?token=query-secret',
      { method: 'POST' }
    );
    const options = createCloudflareSentryOptions(request, {
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
