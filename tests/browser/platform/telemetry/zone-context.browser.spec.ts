import { context, createContextKey } from '@opentelemetry/api';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { afterEach, describe, expect, it } from 'vitest';

describe('browser telemetry context', () => {
  afterEach(() => {
    context.disable();
  });

  it('preserves active context across promise and timer awaits', async () => {
    const manager = new ZoneContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);

    const requestKey = createContextKey('start-ui.request-id');
    const requestContext = context.active().setValue(requestKey, 'request-1');

    await context.with(requestContext, async () => {
      expect(context.active().getValue(requestKey)).toBe('request-1');

      await Promise.resolve();
      expect(context.active().getValue(requestKey)).toBe('request-1');

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(context.active().getValue(requestKey)).toBe('request-1');
    });
  });
});
