import { describe, expect, it } from 'vitest';

import { assertCapabilityAvailable } from '@/modules/kernel/transport/tanstack/capability-availability';
import { ServerFnError } from '@/modules/kernel/transport/tanstack/server-fn-error';

describe('server capability availability', () => {
  it('returns the not-found contract before disabled capability work begins', () => {
    expect(() => assertCapabilityAvailable('book', () => false)).toThrow(
      ServerFnError
    );

    let caught: unknown;
    try {
      assertCapabilityAvailable('book', () => false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('allows enabled capabilities', () => {
    expect(() => assertCapabilityAvailable('book', () => true)).not.toThrow();
  });
});
