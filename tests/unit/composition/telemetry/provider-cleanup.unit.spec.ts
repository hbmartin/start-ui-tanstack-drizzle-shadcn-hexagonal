import { describe, expect, it, vi } from 'vitest';

import { cleanupTelemetryProviders } from '@/composition/telemetry/provider-cleanup';

describe('telemetry provider cleanup', () => {
  it('settles every constructed provider cleanup', async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());

    await expect(
      cleanupTelemetryProviders('otel.test.cleanup', [first, second], 100)
    ).resolves.toBe('cleaned');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('bounds cleanup that never settles', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);

    await expect(
      cleanupTelemetryProviders(
        'otel.test.cleanup',
        [() => new Promise(() => undefined)],
        1
      )
    ).resolves.toBe('timed_out');
    expect(globalThis.console.error).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({ source: 'otel.test.cleanup' })
    );
  });
});
