import { describe, expect, it, vi } from 'vitest';

import { claimTelemetryProviderOwnership } from '@/composition/telemetry/provider-ownership';

describe('telemetry provider ownership', () => {
  it('claims every provider and releases them in reverse order', () => {
    const order: string[] = [];
    const release = claimTelemetryProviderOwnership([
      {
        acquire: () => {
          order.push('claim-context');
          return true;
        },
        name: 'context',
        release: () => order.push('release-context'),
      },
      {
        acquire: () => {
          order.push('claim-trace');
          return true;
        },
        name: 'trace',
        release: () => order.push('release-trace'),
      },
    ]);

    release();

    expect(order).toEqual([
      'claim-context',
      'claim-trace',
      'release-trace',
      'release-context',
    ]);
  });

  it('rolls back owned globals when a later claim is unavailable', () => {
    const releaseContext = vi.fn();
    const claimTrace = vi.fn(() => false);
    const claimMetrics = vi.fn(() => true);

    expect(() =>
      claimTelemetryProviderOwnership([
        {
          acquire: () => true,
          name: 'context',
          release: releaseContext,
        },
        {
          acquire: claimTrace,
          name: 'trace',
          release: vi.fn(),
        },
        {
          acquire: claimMetrics,
          name: 'metrics',
          release: vi.fn(),
        },
      ])
    ).toThrow('OTel trace owner unavailable');
    expect(releaseContext).toHaveBeenCalledOnce();
    expect(claimMetrics).not.toHaveBeenCalled();
  });
});
