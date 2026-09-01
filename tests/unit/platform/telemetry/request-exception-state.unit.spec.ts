import { describe, expect, it } from 'vitest';

import {
  bindRequestExceptionState,
  claimRequestException,
  createRequestExceptionCaptureState,
  getRequestExceptionState,
} from '@/platform/telemetry';

describe('request exception capture state', () => {
  it.each([new Error('shared'), 'primitive failure', 42, null])(
    'claims the same request occurrence once: %s',
    (failure) => {
      const state = createRequestExceptionCaptureState();

      expect(claimRequestException(state, failure)).toBe(true);
      expect(claimRequestException(state, failure)).toBe(false);
      expect(claimRequestException(state, new Error('distinct'))).toBe(true);
    }
  );

  it('does not suppress one failure object across separate requests', () => {
    const failure = new Error('cached failure');
    const first = createRequestExceptionCaptureState();
    const second = createRequestExceptionCaptureState();

    expect(claimRequestException(first, failure)).toBe(true);
    expect(claimRequestException(second, failure)).toBe(true);
  });

  it('binds state to a request without retaining request values globally', () => {
    const request = new Request('https://app.example/');
    const state = createRequestExceptionCaptureState();

    bindRequestExceptionState(request, state);

    expect(getRequestExceptionState(request)).toBe(state);
    expect(
      getRequestExceptionState(new Request('https://app.example/'))
    ).toBeUndefined();
  });
});
