import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry, getTelemetry } from '@/platform/telemetry';
import { configureCloudflareRequestTelemetry } from '@/runtime/cloudflare/request-telemetry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare request telemetry configuration', () => {
  it('keeps native telemetry active when an integration factory fails', () => {
    const nativeTelemetry = createNoOpTelemetry();
    const providerFailure = new Error('integration factory unavailable');
    const consoleError = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => undefined);
    const sentry = {
      eventFiltersIntegration: () => {
        throw providerFailure;
      },
      linkedErrorsIntegration: vi.fn(),
    } as never;

    expect(() =>
      configureCloudflareRequestTelemetry({
        environment: { SENTRY_DSN: 'https://public@example.com/1' },
        nativeTelemetry,
        request: new Request('https://app.example.test/account'),
        sentry,
        sentryRequestIsolationReady: true,
      })
    ).not.toThrow();

    expect(getTelemetry()).toBe(nativeTelemetry);
    expect(consoleError).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({
        errorType: 'Error',
        source: 'sentry.cloudflare.configure',
      })
    );
  });

  it('does not evaluate Sentry integrations when the provider is ineligible', () => {
    const nativeTelemetry = createNoOpTelemetry();
    const integrationFactory = vi.fn(() => {
      throw new Error('must not run');
    });

    const result = configureCloudflareRequestTelemetry({
      environment: {},
      nativeTelemetry,
      request: new Request('https://app.example.test/account'),
      sentry: { eventFiltersIntegration: integrationFactory } as never,
      sentryRequestIsolationReady: true,
    });

    expect(result).toEqual({ sentryEnabled: false });
    expect(integrationFactory).not.toHaveBeenCalled();
    expect(getTelemetry()).toBe(nativeTelemetry);
  });
});
