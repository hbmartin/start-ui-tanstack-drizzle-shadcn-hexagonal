import { describe, expect, it } from 'vitest';

import {
  createPortableFallowAuditConfig,
  resolveFallowAuditArgs,
} from '../../../scripts/run-fallow-audit.mjs';

describe('portable Fallow audit config', () => {
  it('leaves policy packs to the preceding project-wide gate', () => {
    const config = JSON.parse(
      createPortableFallowAuditConfig(
        `{
          // The committed config is JSONC.
          "audit": { "gate": "new-only" },
          "duplicates": { "enabled": true, "mode": "mild" },
          "rulePacks": ["rule-packs/start-ui-web.json"],
        }`
      )
    );

    expect(config).toEqual({
      audit: { gate: 'new-only' },
      duplicates: { enabled: false, mode: 'mild' },
      rulePacks: [],
    });
  });

  it('rejects malformed config and non-string rule-pack entries', () => {
    expect(() => createPortableFallowAuditConfig('{')).toThrow(
      'Invalid Fallow config'
    );
    expect(() =>
      createPortableFallowAuditConfig('{ "rulePacks": [1] }')
    ).toThrow('Fallow rule-pack paths must be strings');
  });

  it('preserves an explicit coverage override', async () => {
    await expect(
      resolveFallowAuditArgs(['--coverage=/tmp/coverage.json', '--quiet'])
    ).resolves.toEqual(['--coverage=/tmp/coverage.json', '--quiet']);
  });
});
