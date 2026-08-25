import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportTelemetryFailure } from '@/platform/telemetry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportTelemetryFailure', () => {
  it('classifies failures without exposing their message', () => {
    const error = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => undefined);

    reportTelemetryFailure(
      'telemetry.test',
      new Error('Bearer secret-token person@example.com')
    );

    expect(error).toHaveBeenCalledWith('telemetry.report_failure', {
      errorType: 'Error',
      source: 'telemetry.test',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
  });

  it('never throws for hostile failures or a throwing fallback sink', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => {
      throw new Error('console failed');
    });
    const hostile = Object.create(Error.prototype, {
      name: {
        get: () => {
          throw new Error('name failed');
        },
      },
    });

    expect(() =>
      reportTelemetryFailure('telemetry.test', hostile)
    ).not.toThrow();
  });
});
