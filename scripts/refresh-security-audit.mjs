import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { computeDependencyStateDigest } from './check-risk-register.mjs';

const root = process.cwd();
const snapshotPath = path.join(root, 'docs/security-audit.snapshot.json');

export function normalizeAuditReport(report, auditStatus) {
  if (
    !report ||
    typeof report !== 'object' ||
    !report.advisories ||
    typeof report.advisories !== 'object' ||
    Array.isArray(report.advisories) ||
    !report.metadata ||
    typeof report.metadata !== 'object' ||
    !report.metadata.vulnerabilities ||
    typeof report.metadata.vulnerabilities !== 'object'
  ) {
    throw new Error('pnpm audit returned an unsupported report schema.');
  }

  const advisories = [];
  for (const advisory of Object.values(report.advisories)) {
    if (
      !advisory ||
      typeof advisory !== 'object' ||
      typeof advisory.github_advisory_id !== 'string' ||
      typeof advisory.module_name !== 'string' ||
      typeof advisory.severity !== 'string' ||
      typeof advisory.title !== 'string'
    ) {
      throw new Error('pnpm audit returned a malformed advisory record.');
    }
    advisories.push({
      id: advisory.github_advisory_id,
      module: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
    });
  }
  advisories.sort((left, right) =>
    `${left.id}:${left.module}`.localeCompare(`${right.id}:${right.module}`)
  );

  if ((auditStatus === 1) !== advisories.length > 0) {
    throw new Error(
      `pnpm audit exit status ${auditStatus} disagrees with ${advisories.length} advisory records.`
    );
  }
  return advisories;
}

export function findTrackedPreReleasePackages(packageJson) {
  const nitro = packageJson.dependencies?.nitro;
  return typeof nitro === 'string' && /(?:nightly|alpha|beta|rc)/iu.test(nitro)
    ? ['nitro']
    : [];
}

function main() {
  const audit = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['audit', '--audit-level=low', '--json'],
    { cwd: root, encoding: 'utf8' }
  );

  if (audit.error) {
    console.error(`Unable to run pnpm audit: ${audit.error.message}`);
    process.exit(1);
  }
  if (audit.signal) {
    console.error(`pnpm audit terminated by signal ${audit.signal}`);
    process.exit(1);
  }
  if (audit.status !== 0 && audit.status !== 1) {
    process.stderr.write(audit.stderr);
    process.exit(audit.status ?? 1);
  }

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    console.error('pnpm audit did not return valid JSON.');
    process.stderr.write(audit.stderr);
    process.exit(1);
  }

  let advisories;
  try {
    advisories = normalizeAuditReport(report, audit.status);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  );
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dependencyStateSha256: computeDependencyStateDigest(root),
    advisories,
    trackedPackages: findTrackedPreReleasePackages(packageJson),
  };
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;

  fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    flag: 'wx',
  });
  fs.renameSync(temporaryPath, snapshotPath);
  console.log(
    `Wrote ${path.relative(root, snapshotPath)} with ${advisories.length} advisories.`
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
