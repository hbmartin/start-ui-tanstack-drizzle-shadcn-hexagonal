import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const LEDGER_PATH = 'docs/audit-remediation-ledger.md';
const START_MARKER = '<!-- audit-remediation-ledger:start -->';
const END_MARKER = '<!-- audit-remediation-ledger:end -->';
const statuses = new Set(['verified-fixed', 'refuted', 'superseded', 'open']);
const requiredIds = [
  'FND-001',
  'FND-002',
  'FND-003',
  'FND-004',
  'FND-005',
  'FND-006',
  'FND-007',
  'DOM-001',
  'DOM-002',
  'DOM-003',
  'DOM-004',
  'DOM-005',
  'DOM-006',
  'DOM-007',
  'DOM-008',
  'DOM-009',
  'DOM-010',
  'RUN-001',
  'RUN-002',
  'RUN-003',
  'RUN-004',
  'RUN-005',
  'RUN-006',
  'RUN-007',
  'RUN-008',
  'RUN-009',
  'RUN-010',
  'RUN-011',
  'RUN-012',
  'OBS-001',
  'OBS-002',
  'OBS-003',
  'OBS-004',
  'OBS-005',
  'OBS-006',
  'OBS-007',
  'OBS-008',
  'OBS-009',
  'OBS-010',
  'QUAL-001',
  'QUAL-002',
  'QUAL-003',
  'QUAL-004',
  'QUAL-005',
  'QUAL-006',
  'QUAL-007',
  'QUAL-008',
  'QUAL-009',
  'QUAL-010',
  'QUAL-011',
  'REL-001',
  'REL-002',
  'REL-003',
  'REL-004',
] as const;
const rootEvidenceFiles = new Set([
  '.env.example',
  '.oxfmtrc.json',
  'AGENTS.md',
  'CONTEXT.md',
  'README.md',
  'docker-compose.yml',
  'instrument.server.mjs',
  'lefthook.yml',
  'package.json',
  'playwright.config.ts',
  'vite.config.ts',
]);

type LedgerRow = Readonly<{
  id: string;
  claim: string;
  status: string;
  implementation: string;
  verification: string;
  disposition: string;
}>;

const stripCode = (value: string) => value.replace(/^`|`$/gu, '');

const parseLedger = (source: string): LedgerRow[] => {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start < 0 || end <= start) {
    throw new Error('Audit-remediation ledger markers are missing or invalid');
  }

  const tableLines = source
    .slice(start + START_MARKER.length, end)
    .split('\n')
    .filter((line) => line.startsWith('|'));
  const [header, separator, ...dataRows] = tableLines;
  if (
    header !==
      '| ID | Audit claim | Status | Implementation evidence | Verification evidence | Release disposition |' ||
    separator !== '| --- | --- | --- | --- | --- | --- |'
  ) {
    throw new Error('Audit-remediation ledger table header is invalid');
  }

  return dataRows.map((line) => {
    if (!/^\| `(?:FND|DOM|RUN|OBS|QUAL|REL)-\d{3}` \|/u.test(line)) {
      throw new Error(`Unrecognized audit-remediation ledger row: ${line}`);
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 6) {
      throw new Error(`Ledger row must contain six cells: ${line}`);
    }
    const [id, claim, status, implementation, verification, disposition] =
      cells;
    return {
      id: stripCode(id ?? ''),
      claim: claim ?? '',
      status: status ?? '',
      implementation: implementation ?? '',
      verification: verification ?? '',
      disposition: disposition ?? '',
    };
  });
};

const referencedPaths = (value: string) =>
  [...value.matchAll(/`([^`]+)`/gu)]
    .map((match) => match[1] ?? '')
    .filter(
      (candidate) => candidate.includes('/') || rootEvidenceFiles.has(candidate)
    );

const source = fs.readFileSync(path.join(process.cwd(), LEDGER_PATH), 'utf8');
const rows = parseLedger(source);
const trackedPaths = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
);
const fieldViolations = rows.flatMap((row) => [
  ...(statuses.has(row.status) ? [] : [`${row.id}: invalid status`]),
  ...(row.claim.length > 20 ? [] : [`${row.id}: claim is too short`]),
  ...(row.implementation.length > 5
    ? []
    : [`${row.id}: implementation evidence is missing`]),
  ...(row.verification.length > 5
    ? []
    : [`${row.id}: verification evidence is missing`]),
  ...(row.disposition.length > 10
    ? []
    : [`${row.id}: release disposition is missing`]),
]);
const dispositionViolations = rows
  .filter((row) => {
    if (row.status === 'open') return !row.disposition.startsWith('BLOCKER:');
    if (row.status === 'refuted' || row.status === 'superseded') {
      return !row.disposition.startsWith('RATIONALE:');
    }
    return !row.disposition.startsWith('Gate:');
  })
  .map((row) => `${row.id}: disposition does not match ${row.status}`);
const evidencePolicyViolations = rows.flatMap((row) => {
  if (row.status === 'verified-fixed') {
    return [
      ...(referencedPaths(row.implementation).length > 0
        ? []
        : [`${row.id}: closed implementation evidence needs a tracked file`]),
      ...(referencedPaths(row.verification).length > 0
        ? []
        : [`${row.id}: closed verification evidence needs a tracked file`]),
    ];
  }
  if (row.status === 'refuted' || row.status === 'superseded') {
    return referencedPaths(row.implementation).length > 0
      ? []
      : [`${row.id}: decision evidence needs a tracked file`];
  }
  return [];
});
const missingEvidencePaths = rows.flatMap((row) =>
  [...referencedPaths(row.implementation), ...referencedPaths(row.verification)]
    .filter(
      (referencedPath) =>
        !trackedPaths.has(referencedPath) ||
        !fs.existsSync(path.join(process.cwd(), referencedPath)) ||
        !fs.statSync(path.join(process.cwd(), referencedPath)).isFile()
    )
    .map((referencedPath) => `${row.id}: ${referencedPath}`)
);

describe('v5 audit-remediation ledger', () => {
  it('covers every accepted remediation workstream exactly once', () => {
    expect(rows.map(({ id }) => id).toSorted()).toEqual(
      [...requiredIds].toSorted()
    );
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
  });

  it('uses closed statuses and complete evidence fields', () => {
    expect(fieldViolations).toEqual([]);
    expect(dispositionViolations).toEqual([]);
    expect(evidencePolicyViolations).toEqual([]);
  });

  it('does not cite missing implementation or verification files', () => {
    expect(missingEvidencePaths).toEqual([]);
  });

  it('keeps final release fail-closed while work remains open', () => {
    const openRows = rows.filter(({ status }) => status === 'open');
    expect(openRows.length).toBeGreaterThan(0);
    expect(source).toContain('Final v5 release requires zero `open` rows.');
  });
});
