import { describe, expect, it } from 'vitest';

import { parseClientEnv } from '@/platform/env/config';

const baseEnvironment = {
  APP_NAME: 'Start UI Test',
  APP_SLUG: 'start-ui-test',
  VITE_BASE_URL: 'http://localhost:3000',
};

describe('client telemetry mode', () => {
  it('defaults to optional mode', () => {
    expect(parseClientEnv(baseEnvironment).TELEMETRY_MODE).toBe('optional');
  });

  it.each(['off', 'optional', 'required'] as const)(
    'accepts the shared %s mode',
    (mode) => {
      expect(
        parseClientEnv({ ...baseEnvironment, TELEMETRY_MODE: mode })
          .TELEMETRY_MODE
      ).toBe(mode);
    }
  );

  it('rejects an unknown mode', () => {
    expect(() =>
      parseClientEnv({ ...baseEnvironment, TELEMETRY_MODE: 'disabled' })
    ).toThrow();
  });
});
