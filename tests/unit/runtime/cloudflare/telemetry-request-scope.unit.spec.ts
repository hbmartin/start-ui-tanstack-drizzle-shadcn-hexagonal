import { describe, expect, it, vi } from 'vitest';

import {
  createNoOpTelemetry,
  setTelemetry,
  telemetryProxy,
} from '@/platform/telemetry';
import {
  initializeCloudflareTelemetryRequestScope,
  runWithCloudflareTelemetry,
} from '@/runtime/cloudflare/telemetry-request-scope';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('Cloudflare telemetry request scope', () => {
  it('isolates overlapping enabled and off request async graphs', async () => {
    initializeCloudflareTelemetryRequestScope();
    const fallbackLog = vi.fn();
    const enabledLog = vi.fn();
    const offLog = vi.fn();
    setTelemetry({ ...createNoOpTelemetry(), emitLog: fallbackLog });
    const enabled = { ...createNoOpTelemetry(), emitLog: enabledLog };
    const off = { ...createNoOpTelemetry(), emitLog: offLog };
    const enabledStarted = deferred();
    const releaseEnabled = deferred();

    const enabledRequest = runWithCloudflareTelemetry(enabled, async () => {
      telemetryProxy.emitLog({ event: 'enabled.before', level: 'info' });
      enabledStarted.resolve();
      await releaseEnabled.promise;
      telemetryProxy.emitLog({ event: 'enabled.after', level: 'info' });
    });
    await enabledStarted.promise;

    const offRequest = runWithCloudflareTelemetry(off, async () => {
      telemetryProxy.emitLog({ event: 'off.only', level: 'info' });
      releaseEnabled.resolve();
    });
    await Promise.all([enabledRequest, offRequest]);

    expect(enabledLog).toHaveBeenCalledTimes(2);
    expect(enabledLog).toHaveBeenNthCalledWith(1, {
      event: 'enabled.before',
      level: 'info',
    });
    expect(enabledLog).toHaveBeenNthCalledWith(2, {
      event: 'enabled.after',
      level: 'info',
    });
    expect(offLog).toHaveBeenCalledExactlyOnceWith({
      event: 'off.only',
      level: 'info',
    });
    expect(fallbackLog).not.toHaveBeenCalled();
  });
});
