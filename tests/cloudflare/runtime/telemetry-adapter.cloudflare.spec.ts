import { tracing } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createCloudflareTelemetryAdapter } from '@/runtime/cloudflare/telemetry-adapter';

describe('Cloudflare telemetry async context', () => {
  it('runs a child operation after await inside the active parent span', async () => {
    const telemetry = createCloudflareTelemetryAdapter({ tracing });

    const result = await telemetry.startSpan(
      { name: 'parent', op: 'http.server' },
      async () => {
        await Promise.resolve();
        return telemetry.startSpan(
          { name: 'child', op: 'db.repository' },
          async () => {
            await Promise.resolve();
            return 'nested-result';
          }
        );
      }
    );

    expect(result).toBe('nested-result');
  });
});
