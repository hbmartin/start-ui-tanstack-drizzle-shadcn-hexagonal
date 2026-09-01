import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BROWSER_TELEMETRY_BUILD_TARGET } from '../../../scripts/browser-telemetry-target';

describe('browser telemetry transform target', () => {
  it('keeps production and browser tests on the shared lowered target', () => {
    expect(BROWSER_TELEMETRY_BUILD_TARGET).toBe('es2015');
    for (const config of ['vite.config.ts', 'vitest.config.ts']) {
      const source = fs.readFileSync(path.join(process.cwd(), config), 'utf8');
      expect(source).toContain('BROWSER_TELEMETRY_BUILD_TARGET');
      expect(source).not.toMatch(/oxc:\s*\{\s*target:\s*['"]es20/u);
    }
  });
});
