import { describe, expect, it } from 'vitest';

import {
  findTrackedPreReleasePackages,
  normalizeAuditReport,
} from '../../../scripts/refresh-security-audit.mjs';

const emptyReport = {
  advisories: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    },
  },
};

describe('security audit refresh parsing', () => {
  it('accepts a successful zero-advisory report', () => {
    expect(normalizeAuditReport(emptyReport, 0)).toEqual([]);
  });

  it('rejects parseable audit error payloads and schema drift', () => {
    expect(() =>
      normalizeAuditReport({ error: 'registry unavailable' }, 1)
    ).toThrow('unsupported report schema');
  });

  it('rejects a nonzero audit result without advisory records', () => {
    expect(() => normalizeAuditReport(emptyReport, 1)).toThrow(
      'disagrees with 0 advisory records'
    );
  });

  it('rejects malformed advisory records', () => {
    expect(() =>
      normalizeAuditReport(
        {
          ...emptyReport,
          advisories: { malformed: { severity: 'moderate' } },
        },
        1
      )
    ).toThrow('malformed advisory record');
  });

  it('tracks Nitro alpha, beta, rc, and nightly specifications', () => {
    for (const version of [
      '3.0.0-alpha.1',
      '3.0.0-beta.2',
      '3.0.0-rc.1',
      'npm:nitro-nightly@3.0.0-20260824',
    ]) {
      expect(
        findTrackedPreReleasePackages({ dependencies: { nitro: version } })
      ).toEqual(['nitro']);
    }
  });
});
