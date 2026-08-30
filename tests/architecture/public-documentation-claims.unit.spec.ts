import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveTrustedTool } from '../../scripts/trusted-tool';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const packageManifest = JSON.parse(
  execFileSync(resolveTrustedTool('git'), ['show', 'HEAD:package.json'], {
    cwd: root,
    encoding: 'utf8',
  })
) as {
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
  repository: { readonly url: string };
  scripts: Readonly<Record<string, string>>;
};
const repositorySlug = new URL(
  packageManifest.repository.url.replace(/^git\+/u, '')
).pathname.replace(/^\/|\.git$/gu, '');
const trackedMarkdown = execFileSync(
  resolveTrustedTool('git'),
  ['ls-files', '-z', '--', '*.md'],
  { cwd: root, encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean);
const historicalEvidence = new Set([
  'docs/adr/0001-fallow-quality-consolidation.md',
  'docs/adr/0002-core-identity-without-tenancy.md',
  'docs/audit-remediation-ledger.md',
  'docs/security-risk-register.md',
]);
const currentGuidanceFiles = trackedMarkdown.filter(
  (file) => !historicalEvidence.has(file)
);
const currentGuidance = currentGuidanceFiles.map((file) => ({
  file,
  source: read(file),
}));
const retiredClaimPatterns = [
  /@softarc\/sheriff|\bSheriff\b/iu,
  /\bdependency-cruiser\b|\bdepcruise\b/iu,
  /\bjscpd\b/iu,
  /\bBiome\b/iu,
  /\bKnip\b/iu,
  /\bReact Cosmos\b/iu,
  /\bReact Hook Form\b/iu,
  /\boRPC\b/u,
  /\bOpenAPI\b|\bSwagger\b/iu,
  /\bPrisma\b|mongodb-memory-server/iu,
  /\bAuthGateway\b|\bUserAdminGateway\b/u,
  /\bbeforeLoadAuthenticated\b/u,
  /\bCodex in-app Browser\b/u,
  /\bfork[- ]sync\b/iu,
];
const retiredClaimHits = currentGuidance.flatMap(({ file, source }) =>
  retiredClaimPatterns
    .filter((pattern) => pattern.test(source))
    .map((pattern) => `${file}: ${pattern.source}`)
);
const pnpmCommandPattern =
  /\bpnpm\s+(?:run\s+)?(?!run\b)([a-z][a-z0-9:_-]*)/giu;
const pnpmBuiltins = new Set(['create', 'dlx', 'exec', 'i', 'install']);
const documentedPnpmCommands = currentGuidance.flatMap(({ file, source }) =>
  [...source.matchAll(pnpmCommandPattern)].map((match) => ({
    command: match[1] ?? '',
    file,
  }))
);
const unknownDocumentedCommands = documentedPnpmCommands
  .filter(
    ({ command }) =>
      !pnpmBuiltins.has(command) &&
      packageManifest.scripts[command] === undefined
  )
  .map(({ command, file }) => `${file}: pnpm ${command}`);
const e2eWorkflow = parseYaml(read('.github/workflows/e2e-tests.yml')) as {
  jobs: {
    E2E: { strategy: { matrix: { browser: ReadonlyArray<string> } } };
    Visual: { name: string };
  };
  on: {
    pull_request: { types: ReadonlyArray<string> };
    push: { tags?: ReadonlyArray<string> };
    schedule?: ReadonlyArray<unknown>;
  };
};

describe('public documentation claims', () => {
  it('derives the public Markdown inventory from tracked files only', () => {
    expect(trackedMarkdown).toEqual(
      expect.arrayContaining([
        'README.md',
        'AGENTS.md',
        'CONTEXT.md',
        'CONTRIBUTING.md',
        'TESTING.md',
        '.github/SECURITY.md',
        'docs/security practices.md',
        'docs/strict-modular-monolith.md',
      ])
    );
  });

  it('keeps retired stack and tooling names in historical evidence only', () => {
    expect(retiredClaimHits).toEqual([]);
  });

  it('documents only available pnpm commands and installed primary tools', () => {
    expect(unknownDocumentedCommands).toEqual([]);

    const dependencies = {
      ...packageManifest.dependencies,
      ...packageManifest.devDependencies,
    };
    expect(Object.keys(dependencies)).toEqual(
      expect.arrayContaining([
        '@base-ui/react',
        '@tanstack/react-form',
        '@tanstack/react-query',
        'fallow',
        'oxfmt',
        'oxlint',
      ])
    );
    const readme = read('README.md');
    for (const technology of [
      'Base UI',
      'TanStack Form',
      'TanStack Query',
      'OpenTelemetry',
    ]) {
      expect(readme).toContain(technology);
    }
  });

  it('keeps runtime documentation at the implemented artifact-readiness level', () => {
    const readme = read('README.md');
    expect(readme).toContain(
      'No profile is declared production-ready in the current v5 alpha.'
    );
    expect(readme).toContain(
      'no Vercel deployment command is release-approved yet'
    );
    expect(readme).toMatch(
      /does\s+not yet expose a Cloudflare preview or deploy script/u
    );
    expect(readme).not.toMatch(
      /Deploy from Git|Deploy from the CLI|pnpm dlx vercel|railway up|render\.yaml/iu
    );
    expect(read('AGENTS.md')).toContain(
      'Cloudflare is artifact-only at this v5 stage.'
    );
    expect(read('CONTEXT.md')).toMatch(
      /Vercel and Cloudflare remain\s+artifact-only/u
    );
  });

  it('describes the current browser matrix without closing future release gates', () => {
    expect(e2eWorkflow.on.pull_request.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
    ]);
    expect(e2eWorkflow.on.schedule).toBeUndefined();
    expect(e2eWorkflow.on.push.tags).toBeUndefined();
    expect(e2eWorkflow.jobs.E2E.strategy.matrix.browser).toEqual([
      'chromium',
      'firefox',
      'webkit',
    ]);
    expect(e2eWorkflow.jobs.Visual.name).toBe('Visual (chromium)');

    const readme = read('README.md');
    expect(readme).toContain(
      'The current non-draft pull-request workflow runs Chromium, Firefox, and WebKit.'
    );
    const ledger = read('docs/audit-remediation-ledger.md');
    expect(ledger).toMatch(/\| `QUAL-008` \|[^\n]+\| open \|/u);
    expect(ledger).toMatch(/\| `QUAL-009` \|[^\n]+\| open \|/u);
  });

  it('matches documented identity, locale, and browser-mutation boundaries', () => {
    const contributing = read('CONTRIBUTING.md');
    for (const locale of ['`en`', '`fr`', '`ar`', '`sw`']) {
      expect(contributing).toContain(locale);
    }

    const modularMonolith = read('docs/strict-modular-monolith.md');
    expect(modularMonolith).toContain(
      'Version 5 is a single-application modular monolith.'
    );
    expect(modularMonolith).not.toMatch(
      /reserved slot for active-tenant|when multi-tenancy is enabled/iu
    );

    const startSource = read('src/start.ts');
    expect(startSource).toContain('createCsrfMiddleware');
    expect(startSource).toContain('browserMutationGuardMiddleware');
    expect(
      read('src/modules/auth/infrastructure/better-auth/cookie-options.ts')
    ).toContain("sameSite: 'lax'");
    for (const securityDoc of [
      read('.github/SECURITY.md'),
      read('docs/security practices.md'),
      modularMonolith,
    ]) {
      expect(securityDoc).toContain('src/start.ts');
      expect(securityDoc).not.toMatch(
        /default chain is in effect|does not define `?src\/start\.ts/iu
      );
    }
  });

  it('keeps provider mappings thin and security links current', () => {
    expect(read('AGENTS.md')).not.toContain('Codex in-app Browser');
    for (const mapping of [
      '.claude/rules/architecture.md',
      '.claude/rules/modules.md',
      '.claude/rules/testing.md',
    ]) {
      const providerMapping = read(mapping);
      expect(providerMapping).toContain('AGENTS.md');
      expect(Buffer.byteLength(providerMapping, 'utf8')).toBeLessThan(1_200);
      expect(providerMapping.split('\n').length).toBeLessThanOrEqual(24);
      expect(providerMapping).not.toMatch(
        /## (?:Public Gates|Module Rules|Common Guardrails|Tests)/u
      );
    }
    expect(read('.vscode/extensions.json')).not.toMatch(/eslint|prisma/iu);

    const security = read('.github/SECURITY.md');
    expect(security).toContain(
      `<https://github.com/${repositorySlug}/security/advisories/new>`
    );
    expect(security).toContain(`--repo ${repositorySlug}`);
    expect(security).toContain('tracked `package.json` metadata');
    expect(security).toContain('| 5.x');
    expect(security).not.toContain('| 4.x');

    expect(read('docs/audit-remediation-ledger.md')).toMatch(
      /\| `QUAL-010` \|[^\n]+\| open \|/u
    );
  });
});
