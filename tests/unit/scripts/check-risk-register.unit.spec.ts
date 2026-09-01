import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findExpiredActiveRisks,
  findExpiredAdvisories,
  findExpiredInactiveRisks,
  parseAcceptedAdvisories,
  parseRiskEntries,
  validateSecuritySnapshot,
} from '../../../scripts/check-risk-register.mjs';

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: '2026-08-24T00:00:00.000Z',
  dependencyStateSha256: 'a'.repeat(64),
  advisories: [],
  trackedPackages: [],
  ...overrides,
});

const register = `# Security Risk Register

## Temporary Accepted Dependency Advisories

| Package | Advisory | Current path | Decision | Next review |
| --- | --- | --- | --- | --- |
| \`esbuild <= 0.24.2\` | GHSA-g7r4-m6w7-qqqr: Dev server request exposure | \`drizzle-kit\` | Temporarily accepted. | 2026-06-30 |
| \`ws 8.19.0\` | DoS via excessive headers | \`react-cosmos\` | Temporarily accepted. | 2025-01-15 |
`;

describe('risk register policy', () => {
  it('parses advisories with their review dates from the register table', () => {
    expect(parseAcceptedAdvisories(register)).toEqual([
      { advisory: '`esbuild <= 0.24.2`', reviewDate: '2026-06-30' },
      { advisory: '`ws 8.19.0`', reviewDate: '2025-01-15' },
    ]);
  });

  it('ignores table rows without a trailing ISO review date', () => {
    const markdown = [
      '| Package | Next review |',
      '| --- | --- |',
      '| `qs 6.15.x` | upgrade when upstream resolves |',
    ].join('\n');

    expect(parseAcceptedAdvisories(markdown)).toEqual([]);
  });

  it('reports only advisories whose review date has passed', () => {
    expect(findExpiredAdvisories(register, '2026-06-09')).toEqual([
      { advisory: '`ws 8.19.0`', reviewDate: '2025-01-15' },
    ]);
  });

  it('keeps advisories reviewed on the current day in good standing', () => {
    expect(findExpiredAdvisories(register, '2025-01-15')).toEqual([]);
  });

  it('flags all advisories once every review date has passed', () => {
    expect(findExpiredAdvisories(register, '2026-07-01')).toHaveLength(2);
  });

  it('fails an expired row only while its advisory is still active', () => {
    const activeSnapshot = {
      advisories: [{ id: 'GHSA-g7r4-m6w7-qqqr' }],
      trackedPackages: [],
    };
    const resolvedSnapshot = { advisories: [], trackedPackages: [] };

    expect(
      findExpiredActiveRisks(register, '2026-07-01', activeSnapshot)
    ).toEqual([expect.objectContaining({ package: '`esbuild <= 0.24.2`' })]);
    expect(
      findExpiredActiveRisks(register, '2026-07-01', resolvedSnapshot)
    ).toEqual([]);
  });

  it('tracks an expired prerelease while the package remains explicitly listed', () => {
    const prereleaseRegister = [
      '## Accepted Pre-release Dependencies',
      '',
      '| Package | Note | Next review |',
      '| --- | --- | --- |',
      '| `nitro` | pinned beta | 2026-01-01 |',
    ].join('\n');

    expect(
      findExpiredActiveRisks(prereleaseRegister, '2026-08-24', {
        advisories: [],
        trackedPackages: ['nitro'],
      })
    ).toEqual([expect.objectContaining({ package: '`nitro`' })]);
  });

  it('extracts advisory identifiers from risk rows', () => {
    expect(parseRiskEntries(register)[0]?.advisoryIds).toEqual([
      'GHSA-g7r4-m6w7-qqqr',
    ]);
  });

  it('always blocks high and critical snapshot findings', () => {
    expect(
      validateSecuritySnapshot(
        register,
        snapshot({
          advisories: [
            {
              id: 'GHSA-critical-test',
              module: 'unsafe-package',
              severity: 'critical',
              title: 'Critical test advisory',
            },
          ],
        })
      )
    ).toEqual([
      'GHSA-critical-test (unsafe-package) is critical and must be fixed',
    ]);
  });

  it('requires lower-severity findings to be registered', () => {
    expect(
      validateSecuritySnapshot(
        register,
        snapshot({
          advisories: [
            {
              id: 'GHSA-unregistered-test',
              module: 'review-package',
              severity: 'moderate',
              title: 'Moderate test advisory',
            },
          ],
        })
      )
    ).toEqual([
      'GHSA-unregistered-test (review-package) is active but missing from the risk register',
    ]);
  });

  it('rejects malformed comparison dates', () => {
    expect(() => findExpiredAdvisories(register, 'tomorrow')).toThrow(
      'Invalid ISO date: tomorrow'
    );
  });

  it('rejects impossible calendar dates in risk rows', () => {
    const invalidRegister = register.replace('2026-06-30', '2026-99-99');
    expect(() => parseRiskEntries(invalidRegister)).toThrow(
      'Invalid ISO date: 2026-99-99'
    );
  });

  it('requests review without failing when an expired risk is inactive', () => {
    expect(
      findExpiredInactiveRisks(register, '2026-07-01', {
        advisories: [],
        trackedPackages: [],
      })
    ).toHaveLength(2);
  });

  it('rejects a snapshot from a different dependency state', () => {
    expect(
      validateSecuritySnapshot(register, snapshot(), 'b'.repeat(64))
    ).toContain(
      'security snapshot is stale for package.json, pnpm-lock.yaml, or pnpm-workspace.yaml; run pnpm security:refresh and review the result'
    );
  });

  it('parses review dates out of the real risk register', () => {
    const realRegister = fs.readFileSync(
      path.join(process.cwd(), 'docs/security-risk-register.md'),
      'utf8'
    );
    const entries = parseAcceptedAdvisories(realRegister);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.reviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
