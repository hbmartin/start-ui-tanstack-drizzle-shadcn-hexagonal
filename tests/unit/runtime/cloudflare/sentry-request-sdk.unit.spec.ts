import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Cloudflare Sentry SDK lifecycle', () => {
  it('retains the isolated request client for deferred stream capture', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(
          process.cwd(),
          'tests/support/cloudflare-sentry-lifecycle-probe.ts'
        ),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
        killSignal: 'SIGKILL',
        timeout: 10_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(result.stdout).toContain('{"cloudflareSentryLifecycle":"passed"}');
  }, 15_000);
});
