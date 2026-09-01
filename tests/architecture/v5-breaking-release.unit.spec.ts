import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const readProjectFile = (file: string) =>
  fs.readFileSync(path.join(root, file), 'utf8');
const packageManifest = JSON.parse(readProjectFile('package.json')) as {
  author?: Readonly<Record<string, unknown>>;
  scripts?: Readonly<Record<string, string>>;
  version?: string;
};

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const publicGateNames = new Set([
  'administration.ts',
  'backend.ts',
  'client.ts',
  'index.ts',
  'manifest.ts',
  'middleware.ts',
  'persistence.ts',
  'presentation.ts',
  'server.ts',
  'testing.ts',
]);

const publicGates = trackedFiles.filter((file) => {
  const parts = file.split('/');
  return (
    parts[0] === 'src' &&
    parts[1] === 'modules' &&
    parts.length === 4 &&
    publicGateNames.has(parts[3] ?? '')
  );
});

type AstNode = {
  argument?: unknown;
  declarations?: ReadonlyArray<Readonly<{ id?: unknown }>>;
  declaration?: Readonly<{
    declarations?: ReadonlyArray<Readonly<{ id?: unknown }>>;
    id?: unknown;
    type?: string;
  }> | null;
  exported?: unknown;
  elements?: ReadonlyArray<unknown>;
  expressions?: ReadonlyArray<unknown>;
  id?: unknown;
  left?: unknown;
  name?: unknown;
  properties?: ReadonlyArray<AstNode>;
  quasis?: ReadonlyArray<
    Readonly<{ value?: Readonly<{ cooked?: unknown; raw?: unknown }> }>
  >;
  source?: unknown;
  specifiers?: ReadonlyArray<Readonly<{ exported?: unknown }>>;
  type?: string;
  value?: unknown;
};

const staticName = (node: unknown) => {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as AstNode;
  return candidate.type === 'Identifier' && typeof candidate.name === 'string'
    ? candidate.name
    : undefined;
};

const staticExportName = (node: unknown) =>
  staticName(node) ?? staticString(node);

const staticString = (node: unknown) => {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as AstNode;
  if (candidate.type === 'Literal' && typeof candidate.value === 'string') {
    return candidate.value;
  }
  if (
    candidate.type === 'TemplateLiteral' &&
    candidate.expressions?.length === 0 &&
    candidate.quasis?.length === 1
  ) {
    const value = candidate.quasis[0]?.value;
    return typeof value?.cooked === 'string'
      ? value.cooked
      : typeof value?.raw === 'string'
        ? value.raw
        : undefined;
  }
  return undefined;
};

const parseProjectFile = (file: string) => {
  const parsed = parseSync(file, readProjectFile(file), {
    sourceType: 'module',
  });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${file}: ${parsed.errors[0]?.message}`);
  }
  return parsed.program;
};

const resolveProjectModule = (fromFile: string, specifier: string) => {
  const target = specifier.startsWith('@/')
    ? path.resolve(root, 'src', specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(root, path.dirname(fromFile), specifier)
      : undefined;
  if (!target) return undefined;
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx'),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  return resolved
    ? path.relative(root, resolved).split(path.sep).join('/')
    : undefined;
};

const bindingNames = (node: unknown): ReadonlyArray<string> => {
  const direct = staticName(node);
  if (direct) return [direct];
  if (!node || typeof node !== 'object') return [];
  const candidate = node as AstNode;
  if (candidate.type === 'ObjectPattern') {
    return (candidate.properties ?? []).flatMap((property) =>
      property.type === 'Property'
        ? bindingNames(property.value)
        : bindingNames(property.argument)
    );
  }
  if (candidate.type === 'ArrayPattern') {
    return (candidate.elements ?? []).flatMap(bindingNames);
  }
  if (candidate.type === 'AssignmentPattern') {
    return bindingNames(candidate.left);
  }
  if (candidate.type === 'RestElement') {
    return bindingNames(candidate.argument);
  }
  return [];
};

const exportedDeclarationNames = (declaration: AstNode) => {
  const direct = bindingNames(declaration.id);
  const variables = (declaration.declarations ?? []).flatMap(({ id }) =>
    bindingNames(id)
  );
  return [...direct, ...variables];
};

const collectExportedNames = (
  file: string,
  visited = new Set<string>()
): ReadonlyArray<string> => {
  if (visited.has(file)) return [];
  visited.add(file);

  const body = parseProjectFile(file).body as ReadonlyArray<AstNode>;
  const names = body.flatMap((node) => {
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration
        ? exportedDeclarationNames(node.declaration)
        : [];
      const specifiers = (node.specifiers ?? [])
        .map(({ exported }) => staticExportName(exported))
        .filter((name): name is string => name !== undefined);
      return [...declaration, ...specifiers];
    }
    if (node.type !== 'ExportAllDeclaration') return [];

    const namespaceName = staticExportName(node.exported);
    if (namespaceName) return [namespaceName];
    const specifier = staticString(node.source);
    if (!specifier) return [];
    const target = resolveProjectModule(file, specifier);
    if (!target) {
      throw new Error(
        `Unable to inspect export-star target ${specifier} from ${file}`
      );
    }
    return collectExportedNames(target, visited);
  });

  return [...new Set(names)].toSorted();
};

const splitIdentifierWords = (value: string) =>
  value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2');
const normalizeTechnicalV4Terms = (value: string) =>
  value
    .replace(
      /(^|[^A-Za-z0-9])sig([^A-Za-z0-9]+)v4(?=$|[^A-Za-z0-9])/giu,
      '$1signatureversionfour'
    )
    .replace(
      /(^|[^A-Za-z0-9])ip([^A-Za-z0-9]+)v4(?=$|[^A-Za-z0-9])/giu,
      '$1internetprotocolversionfour'
    );
const hasBridgeToken = (value: string) => {
  const normalized = normalizeTechnicalV4Terms(splitIdentifierWords(value));
  return /(?:^|[^A-Za-z0-9])(?:codemods?|v4(?:compat(?:ibility)?|bridges?|migrations?|upgrades?|aliases?|shims?)?)(?=$|[^A-Za-z0-9])/iu.test(
    normalized
  );
};
const hasAccountIdentifierWord = (value: string) =>
  splitIdentifierWords(value)
    .split(/[^A-Za-z0-9]+/u)
    .some((word) => word.toLowerCase() === 'account');
const isV5ReleaseVersion = (version: string) =>
  /^5\.0\.0(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version);
const currentVersionIsV5 = isV5ReleaseVersion(packageManifest.version ?? '');
const isLegacyAccountRoute = (value: string) =>
  /^\/(?:app|manager)\/account(?:[/?#]|$)/u.test(value);
const isEvidenceOnlyPath = (file: string) => /^(?:docs|tests)\//u.test(file);
const isLegacyRouteFile = (file: string) => {
  if (!file.startsWith('src/routes/')) return false;
  const routePath = file.slice('src/routes/'.length);
  return /(?:^|[/.])(?:app|manager)[/.]account(?:[/._-]|$)/iu.test(routePath);
};

const bridgePaths = trackedFiles.filter(
  (file) => !isEvidenceOnlyPath(file) && hasBridgeToken(file)
);
const bridgeScripts = Object.entries(packageManifest.scripts ?? {}).filter(
  ([name, command]) => hasBridgeToken(name) || hasBridgeToken(command)
);
const legacyModulePaths = trackedFiles.filter((file) =>
  /^src\/modules\/account(?:\/|$)/iu.test(file)
);
const legacyRouteFiles = trackedFiles.filter(isLegacyRouteFile);
const legacyRouteLiterals = trackedFiles
  .filter((file) => /^src\/.*\.[cm]?[jt]sx?$/u.test(file))
  .flatMap((file) => {
    const matches: string[] = [];
    new Visitor({
      Literal(node) {
        const value = staticString(node);
        if (value && isLegacyAccountRoute(value)) matches.push(file);
      },
      TemplateLiteral(node) {
        const value = staticString(node);
        if (value && isLegacyAccountRoute(value)) matches.push(file);
      },
    }).visit(parseProjectFile(file));
    return matches;
  });
const exactLegacyNames = new Set(['Account', 'AccountId', 'AccountProfile']);
const legacyPublicExports = publicGates.flatMap((file) =>
  collectExportedNames(file)
    .filter((name) => exactLegacyNames.has(name))
    .map((name) => `${file}:${name}`)
);
const legacyProfileExports = publicGates
  .filter((file) => file.startsWith('src/modules/profile/'))
  .flatMap((file) =>
    collectExportedNames(file)
      .filter(hasAccountIdentifierWord)
      .map((name) => `${file}:${name}`)
  );

describe('v5 breaking-release policy', () => {
  it('preserves the original template-author attribution', () => {
    expect(packageManifest.author).toEqual({
      name: 'Ivan Dalmet',
      email: 'ivan@dalmet.fr',
      url: 'https://github.com/ivan-dalmet',
    });
    expect(readProjectFile('README.md')).toContain(
      'created & maintained by the [BearStudio Team](https://www.bearstudio.fr/team) and other contributors'
    );
  });

  it('declares a v5 breaking release without compatibility exports or redirects', () => {
    expect(currentVersionIsV5).toBe(true);
    const decision = readProjectFile(
      'docs/adr/0002-core-identity-without-tenancy.md'
    );
    expect(decision).toMatch(
      /breaking rename with no compatibility exports or route\s+redirects/u
    );
  });

  it('does not ship v4 or codemod bridge paths and commands', () => {
    expect(bridgePaths).toEqual([]);
    expect(bridgeScripts).toEqual([]);
    expect(legacyModulePaths).toEqual([]);
  });

  it('does not expose legacy Account aliases or routes', () => {
    expect(legacyPublicExports).toEqual([]);
    expect(legacyProfileExports).toEqual([]);
    expect(legacyRouteFiles).toEqual([]);
    expect(legacyRouteLiterals).toEqual([]);
  });

  it.each([
    ['5.0.0-alpha.7', true],
    ['5.0.0-beta.2', true],
    ['5.0.0-rc.1', true],
    ['5.0.0', true],
    ['4.9.9', false],
    ['5.0.1', false],
  ] as const)('classifies release version %s', (version, accepted) => {
    expect(isV5ReleaseVersion(version)).toBe(accepted);
  });

  it.each([
    ['codemod src', true],
    ['node codemod src', true],
    ['node v4 src', true],
    ['scripts/migrate-v4.ts', true],
    ['scripts/codemodV4.ts', true],
    ['scripts/runCodemod.ts', true],
    ['scripts/v4compat.ts', true],
    ['migrate:v4Compat', true],
    ['shipV4Compat.ts', true],
    ['zipV4Migration.ts', true],
    ['stripV4Bridge.ts', true],
    ['scripts/ship-v4-compat.ts', true],
    ['node ipv4-check.mjs', false],
    ['node sigv4-request.mjs', false],
    ['node ipV4Check.mjs', false],
    ['node sigV4Request.mjs', false],
    ['src/aws/SigV4Signer.ts', false],
  ] as const)('classifies bridge token %s', (value, detected) => {
    expect(hasBridgeToken(value)).toBe(detected);
  });

  it.each([
    ['Account', true],
    ['CurrentAccount', true],
    ['AccountSettings', true],
    ['accountQueryOptions', true],
    ['legacy_account', true],
    ['AccountabilitySettings', false],
    ['ProfileAccountability', false],
    ['AccountingPreferences', false],
  ] as const)('classifies Profile export %s', (value, detected) => {
    expect(hasAccountIdentifierWord(value)).toBe(detected);
  });

  it.each([
    ['Account', true],
    ['AccountId', true],
    ['AccountProfile', true],
    ['ProviderAccount', false],
    ['OAuthAccount', false],
    ['AccountCredential', false],
  ] as const)('classifies exact legacy export %s', (value, detected) => {
    expect(exactLegacyNames.has(value)).toBe(detected);
  });

  it.each([
    ['/app/account', true],
    ['/app/account/', true],
    ['/manager/account?from=old', true],
    ['/manager/account#old', true],
    ['/api/provider/account', false],
    ['/app/profile', false],
  ] as const)('classifies legacy route %s', (value, detected) => {
    expect(isLegacyAccountRoute(value)).toBe(detected);
  });

  it('follows export-star chains when checking the public surface', () => {
    expect(
      collectExportedNames(
        'tests/architecture/fixtures/v5-breaking-release/profile-index.fixture.ts'
      ).filter(hasAccountIdentifierWord)
    ).toEqual(['Account', 'AccountId', 'AccountProfile']);
    expect(
      collectExportedNames(
        'tests/architecture/fixtures/v5-breaking-release/profile-alias-index.fixture.ts'
      ).filter(hasAccountIdentifierWord)
    ).toEqual(['Account', 'AccountId', 'AccountProfile']);
  });
});
