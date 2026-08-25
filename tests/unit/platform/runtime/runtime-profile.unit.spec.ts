import { describe, expect, it } from 'vitest';

import {
  parseRuntimeProfile,
  runtimeCapabilityRequirements,
  runtimeProfiles,
} from '@/platform/runtime/runtime-profile';

describe('runtime profiles', () => {
  it('keeps the supported profile set explicit and closed', () => {
    expect(runtimeProfiles).toEqual(['node', 'vercel', 'cloudflare']);
    expect(runtimeProfiles.map(parseRuntimeProfile)).toEqual(runtimeProfiles);
    expect(() => parseRuntimeProfile('auto')).toThrow(/must be one of/);
  });

  it('declares profile-owned adapter capabilities', () => {
    expect(runtimeCapabilityRequirements).toEqual({
      node: {
        database: 'postgres-node',
        lifecycle: 'persistent-process',
        objectStorage: 's3-compatible',
        rateLimiting: 'upstash',
        telemetry: 'node-sdk',
        trustedClientIp: 'trusted-proxy-chain',
      },
      vercel: {
        database: 'postgres-fetch',
        lifecycle: 'vercel-wait-until',
        objectStorage: 's3-compatible',
        rateLimiting: 'upstash',
        telemetry: 'vercel-otel',
        trustedClientIp: 'vercel-forwarded-for',
      },
      cloudflare: {
        database: 'hyperdrive',
        lifecycle: 'cloudflare-execution-context',
        objectStorage: 'r2',
        rateLimiting: 'cloudflare-waf-with-upstash',
        telemetry: 'cloudflare-otel',
        trustedClientIp: 'cloudflare-connecting-ip',
      },
    });
  });
});
