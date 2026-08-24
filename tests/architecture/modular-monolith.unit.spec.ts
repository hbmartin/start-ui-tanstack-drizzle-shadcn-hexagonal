/* oxlint-disable vitest/no-conditional-in-test -- Architecture guardrails branch over discovered files to produce precise violation lists. */

import fs from 'node:fs';
import path from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

import { isProtectedNavigationPath } from '@/platform/router';

const root = process.cwd();
const sourceFileExtensions = new Set(['.ts', '.tsx']);
const transactionApplicationErrorBoundaryFiles = new Set([
  path.join(
    'src',
    'modules',
    'email',
    'application',
    'use-cases',
    'process-email-status-event.ts'
  ),
]);
const protectedRouteGuardSpecs = [
  {
    file: path.join(root, 'src', 'routes', 'app', 'route.tsx'),
    guard: 'requireAuthenticatedRoute',
  },
  {
    file: path.join(root, 'src', 'routes', 'manager', 'route.tsx'),
    guard: 'requireAuthenticatedRouteOrForbidden',
  },
  {
    file: path.join(root, 'src', 'routes', 'onboarding', 'route.tsx'),
    guard: 'requireOnboardingRoute',
  },
  {
    file: path.join(root, 'src', 'routes', 'login', 'route.tsx'),
    guard: 'redirectAuthenticatedRoute',
  },
];
const portOutcomeOffenderOrder = ['nullable', 'optional', 'boolean'] as const;
const directProtectedNavigationAllowlist = new Set([
  path.join(root, 'src', 'platform', 'router', 'navigation-safety.ts'),
  path.join(root, 'src', 'routes', 'logout.tsx'),
  path.join(root, 'src', 'routeTree.gen.ts'),
]);

type PortOutcomeOffender = (typeof portOutcomeOffenderOrder)[number];

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    return sourceFileExtensions.has(path.extname(dir)) ? [dir] : [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    return sourceFileExtensions.has(path.extname(entry.name))
      ? [entryPath]
      : [];
  });
}

function findImportViolations(files: string[], pattern: RegExp) {
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    pattern.lastIndex = 0;
    return pattern.test(source) ? [path.relative(root, file)] : [];
  });
}

function findRuntimeImportViolations(files: string[], pattern: RegExp) {
  return files.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        pattern.lastIndex = 0;
        const isTypeOnlyImport = line.trimStart().startsWith('import type');
        return !isTypeOnlyImport && pattern.test(line)
          ? [`${path.relative(root, file)}:${index + 1}`]
          : [];
      })
  );
}

function readSource(file: string) {
  return fs.readFileSync(file, 'utf8');
}

function relativePath(file: string) {
  return path.relative(root, file);
}

type NavigationAstNode = {
  expression?: unknown;
  expressions?: unknown[];
  name?: unknown;
  quasis?: Array<{ value?: { cooked?: unknown; raw?: unknown } }>;
  start?: number;
  type?: unknown;
  value?: unknown;
};

function getStaticString(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as NavigationAstNode;
  if (candidate.type === 'Literal' && typeof candidate.value === 'string') {
    return candidate.value;
  }
  if (candidate.type === 'JSXExpressionContainer') {
    return getStaticString(candidate.expression);
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
}

function getStaticPropertyName(node: unknown) {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as NavigationAstNode;
  if (
    (candidate.type === 'Identifier' || candidate.type === 'JSXIdentifier') &&
    typeof candidate.name === 'string'
  ) {
    return candidate.name;
  }
  return getStaticString(candidate);
}

function findStaticProtectedNavigationLocations(file: string, source: string) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${file}: ${parsed.errors[0]?.message}`);
  }

  const locations: string[] = [];
  const addTarget = (node: unknown, start: number) => {
    const target = getStaticString(node);
    if (!target || !isProtectedNavigationPath(target)) return;
    const line = source.slice(0, start).split('\n').length;
    locations.push(`${path.relative(root, file)}:${line}`);
  };

  new Visitor({
    JSXAttribute(node) {
      if (getStaticPropertyName(node.name) === 'to') {
        addTarget(node.value, node.start);
      }
    },
    Property(node) {
      if (!node.computed && getStaticPropertyName(node.key) === 'to') {
        addTarget(node.value, node.start);
      }
    },
  }).visit(parsed.program);

  return locations;
}

function findDirectProtectedNavigationViolations() {
  return listSourceFiles(path.join(root, 'src'))
    .filter((file) => !directProtectedNavigationAllowlist.has(file))
    .flatMap((file) =>
      findStaticProtectedNavigationLocations(file, readSource(file))
    );
}

function findPromisePayloads(source: string) {
  const payloads: string[] = [];
  const promiseStartPattern = /\bPromise\s*</gu;

  for (const match of source.matchAll(promiseStartPattern)) {
    const payloadStart = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let cursor = payloadStart;

    for (; cursor < source.length && depth > 0; cursor += 1) {
      if (source[cursor] === '<') depth += 1;
      if (source[cursor] === '>') depth -= 1;
    }

    if (depth === 0) payloads.push(source.slice(payloadStart, cursor - 1));
  }

  return payloads;
}

function findPortPromiseOutcomeOffenders(
  source: string,
  _fileName = 'port.ts'
) {
  const offenders = new Set<PortOutcomeOffender>();

  for (const payload of findPromisePayloads(source)) {
    if (/\bnull\b/u.test(payload)) offenders.add('nullable');
    if (/\bundefined\b/u.test(payload)) offenders.add('optional');
    if (/\bboolean\b/u.test(payload)) offenders.add('boolean');
  }

  return portOutcomeOffenderOrder.filter((offender) => offenders.has(offender));
}

function findServerFunctionExports(files: string[]) {
  const pattern = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*createServerFn\s*\(/g;

  return files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const matches = Array.from(source.matchAll(pattern));

    return matches.map((match, index) => {
      const [, name] = match;
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? source.length;
      const declaration = source.slice(start, end);
      const methodMatch = declaration.match(
        /createServerFn\s*\(\s*\{\s*method:\s*['"]([A-Z]+)['"]/
      );

      return {
        declaration,
        file,
        method: methodMatch?.[1] ?? 'UNKNOWN',
        name: name ?? '',
        source,
      };
    });
  });
}

function isServerFunctionEntrypoint(file: string) {
  return fs.readFileSync(file, 'utf8').includes('createServerFn');
}

function isPathInside(relativeFile: string, relativeDir: string) {
  return (
    relativeFile === relativeDir ||
    relativeFile.startsWith(`${relativeDir}${path.sep}`)
  );
}

function findProtectedRouteGuardViolations() {
  const forbiddenAuthImports =
    /from\s+['"](?:@\/composition\/auth|@\/modules\/auth\/(?:backend|client|infrastructure)(?:\/[^'"]*)?|better-auth(?:\/[^'"]*)?|@workos(?:-inc)?\/[^'"]+)['"]/;

  return protectedRouteGuardSpecs.flatMap(({ file, guard }) => {
    const source = readSource(file);
    const relative = relativePath(file);
    const checks = [
      {
        ok: source.includes('beforeLoad'),
        violation: `${relative}:missing beforeLoad`,
      },
      {
        ok: source.includes(guard),
        violation: `${relative}:missing ${guard}`,
      },
      {
        ok: !forbiddenAuthImports.test(source),
        violation: `${relative}:provider import`,
      },
    ];

    return checks.filter((check) => !check.ok).map((check) => check.violation);
  });
}

function findPrivilegedServerFunctionRunnerViolations(
  serverFiles: string[],
  publicServerFunctions: ReadonlySet<string>
) {
  const usesRunner = (declaration: string, runnerName: string) =>
    declaration.includes(`${runnerName}(`) ||
    declaration.includes(`${runnerName}.withOperation(`);

  return findServerFunctionExports(serverFiles).flatMap(
    ({ declaration, file, method, name, source }) => {
      if (publicServerFunctions.has(name)) return [];

      const relative = path.relative(root, file);
      const methodRunnerChecks =
        method === 'GET'
          ? [
              {
                ok: source.includes('withProtectedContext'),
                violation: `${relative}:${name}:missing read runner`,
              },
              {
                ok: usesRunner(declaration, 'runProtected'),
                violation: `${relative}:${name}:not using read runner`,
              },
            ]
          : method === 'POST'
            ? [
                {
                  // `withFreshProtectedMutation` is a stricter protected
                  // mutation runner (adds step-up freshness) and is equally
                  // acceptable here.
                  ok:
                    source.includes('withProtectedMutation') ||
                    source.includes('withFreshProtectedMutation'),
                  violation: `${relative}:${name}:missing mutation runner`,
                },
                {
                  ok:
                    usesRunner(declaration, 'runMutation') ||
                    usesRunner(declaration, 'runFreshMutation'),
                  violation: `${relative}:${name}:not using mutation runner`,
                },
              ]
            : [
                {
                  ok: false,
                  violation: `${relative}:${name}:unsupported method ${method}`,
                },
              ];

      return [
        {
          ok: source.includes('createServerFunctionInvoker'),
          violation: `${relative}:${name}:missing invoker`,
        },
        ...methodRunnerChecks,
      ]
        .filter((check) => !check.ok && check.violation)
        .map((check) => check.violation);
    }
  );
}

function isDrizzleImportAllowedSource(relativeFile: string) {
  const segments = relativeFile.split(path.sep);

  return (
    isPathInside(
      relativeFile,
      path.join('src', 'modules', 'kernel', 'infrastructure', 'db')
    ) ||
    isPathInside(
      relativeFile,
      path.join('src', 'modules', 'auth', 'infrastructure', 'better-auth')
    ) ||
    (segments[0] === 'src' &&
      segments[1] === 'modules' &&
      segments[3] === 'infrastructure' &&
      segments[4] === 'drizzle')
  );
}

describe('strict modular monolith layout', () => {
  it('keeps legacy feature and shared roots removed', () => {
    expect(fs.existsSync(path.join(root, 'src/features'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/components'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/hooks'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/lib'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/layout'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/emails'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/platform'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/app'))).toBe(true);
    for (const appSupportRoot of ['build-info', 'devtools', 'i18n', 'shell']) {
      expect(fs.existsSync(path.join(root, 'src/app', appSupportRoot))).toBe(
        true
      );
    }
  });

  it('requires module public split barrels where modules expose adapters', () => {
    for (const moduleName of ['profile', 'auth', 'book', 'genre', 'user']) {
      const moduleRoot = path.join(root, 'src/modules', moduleName);
      expect(fs.existsSync(path.join(moduleRoot, 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(moduleRoot, 'presentation.ts'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(moduleRoot, 'server.ts'))).toBe(true);
      expect(fs.existsSync(path.join(moduleRoot, 'client.ts'))).toBe(true);
      expect(fs.existsSync(path.join(moduleRoot, 'testing.ts'))).toBe(true);
      expect(fs.existsSync(path.join(moduleRoot, 'manifest.ts'))).toBe(true);
    }
  });

  it('keeps core business modules in vertical hexagonal slices', () => {
    for (const moduleName of ['profile', 'book', 'genre', 'user']) {
      const moduleRoot = path.join(root, 'src/modules', moduleName);

      for (const expectedPath of [
        'domain',
        path.join('application', 'use-cases'),
        path.join('application', 'ports'),
        path.join('transport', 'http'),
        'factory.ts',
        'index.ts',
      ]) {
        expect(fs.existsSync(path.join(moduleRoot, expectedPath))).toBe(true);
      }
    }

    for (const moduleName of ['auth', 'book', 'email', 'genre']) {
      expect(
        fs.existsSync(
          path.join(root, 'src/modules', moduleName, 'persistence.ts')
        )
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            root,
            'src/modules',
            moduleName,
            'infrastructure',
            'drizzle',
            'schema.ts'
          )
        )
      ).toBe(true);
    }
  });

  it('keeps platform isolated from app code', () => {
    expect(
      findImportViolations(
        listSourceFiles(path.join(root, 'src/platform')),
        /from\s+['"]@\/(?:modules|routes|composition)(?:\/[^'"]*)?['"]/g
      )
    ).toEqual([]);
  });

  it('keeps module internals independent from composition', () => {
    const moduleRoots = fs
      .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, 'src/modules', entry.name));

    const internalFiles = moduleRoots.flatMap((moduleRoot) => [
      ...[
        'domain',
        'application',
        'infrastructure',
        'transport',
        'presentation',
      ].flatMap((dirName) => listSourceFiles(path.join(moduleRoot, dirName))),
      ...listSourceFiles(path.join(moduleRoot, 'factory.ts')),
    ]);

    expect(
      findImportViolations(
        internalFiles,
        /from\s+['"]@\/composition(?:\/[^'"]*)?['"]/g
      )
    ).toEqual([]);
  });

  it('keeps feature modules independent from app support code', () => {
    expect(
      findImportViolations(
        listSourceFiles(path.join(root, 'src/modules')),
        /from\s+['"]@\/app(?:\/[^'"]*)?['"]/g
      )
    ).toEqual([]);
  });

  it('keeps testing gates out of production source imports', () => {
    const productionFiles = listSourceFiles(path.join(root, 'src')).filter(
      (file) =>
        !/[/\\](?:modules[/\\][^/\\]+|platform[/\\]runtime-config)[/\\]testing\.ts$/.test(
          file
        )
    );

    expect(
      findImportViolations(
        productionFiles,
        /from\s+['"]@\/(?:modules\/[^/'"]+|platform\/runtime-config)\/testing(?:\.[^/'"]*)?['"]/g
      )
    ).toEqual([]);
  });

  it('keeps feature repositories from starting database transactions directly', () => {
    const featureInfrastructureFiles = fs
      .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'kernel')
      .flatMap((entry) =>
        listSourceFiles(
          path.join(root, 'src/modules', entry.name, 'infrastructure')
        )
      );

    expect(
      findImportViolations(
        featureInfrastructureFiles,
        /\brunWithDbTransaction\b/g
      )
    ).toEqual([]);
  });

  it('keeps routes on module public APIs', () => {
    expect(
      findImportViolations(
        listSourceFiles(path.join(root, 'src/routes')),
        /from\s+['"]@\/modules\/[^/'"]+\/(?!(?:index|presentation|server|backend|client|testing)(?:\.[^/'"]+)?(?:['"]|$))[^'"]+['"]/g
      )
    ).toEqual([]);
  });

  it('keeps router SSR query integration request scoped', () => {
    const source = readSource(path.join(root, 'src', 'router.tsx'));
    const getRouterIndex = source.indexOf('export function getRouter()');

    expect(getRouterIndex).toBeGreaterThan(-1);
    expect(source.slice(0, getRouterIndex)).not.toMatch(
      /\bcreateClientQueryClient\s*\(/
    );
    expect(source).toMatch(
      /export function getRouter\(\)\s*\{[\s\S]*?\bconst queryClient = createClientQueryClient\(\);/
    );
    expect(source).toContain('setupRouterSsrQueryIntegration({');
    expect(source).toContain('wrapQueryClient: false');
  });

  it('keeps protected route trees SSR-enabled', () => {
    const protectedRouteFiles = [
      ...listSourceFiles(path.join(root, 'src', 'routes', 'app')),
      ...listSourceFiles(path.join(root, 'src', 'routes', 'manager')),
      ...listSourceFiles(path.join(root, 'src', 'routes', 'onboarding')),
    ];
    const violations = protectedRouteFiles
      .filter((file) =>
        /\b(?:defaultSsr|ssr)\s*:\s*false\b/.test(readSource(file))
      )
      .map(relativePath);

    expect(violations).toEqual([]);
  });

  it('keeps protected route beforeLoad guards provider-neutral', () => {
    expect(findProtectedRouteGuardViolations()).toEqual([]);
  });

  it('keeps query factories injected instead of wired to concrete server facades', () => {
    const queryFactoryFiles = [
      ...listSourceFiles(path.join(root, 'src', 'modules')).filter((file) =>
        /[/\\]presentation[/\\]queries\.ts$/.test(file)
      ),
      path.join(
        root,
        'src',
        'platform',
        'runtime-config',
        'presentation',
        'queries.ts'
      ),
    ];

    expect(
      findRuntimeImportViolations(
        queryFactoryFiles,
        /(?:from\s+['"](?:\.\.?\/server|@\/composition(?:\/[^'"]*)?)['"]|import\s*\(\s*['"]@\/composition(?:\/[^'"]*)?['"]\s*\))/g
      )
    ).toEqual([]);
  });

  it('keeps logout as a POST-only side effect', () => {
    const logoutRoute = readSource(
      path.join(root, 'src', 'routes', 'logout.tsx')
    );
    const logoutPage = readSource(
      path.join(
        root,
        'src',
        'modules',
        'auth',
        'presentation',
        'page-logout.tsx'
      )
    );
    const confirmSignOut = readSource(
      path.join(
        root,
        'src',
        'modules',
        'auth',
        'presentation',
        'confirm-signout.tsx'
      )
    );

    expect(logoutRoute).toContain('handleLogoutGetRequest');
    expect(logoutRoute).toContain('handleLogoutPostRequest');
    expect(logoutRoute).toMatch(
      /\bGET:\s*\(\)\s*=>\s*handleLogoutGetRequest\(\)/
    );
    expect(logoutRoute).toMatch(
      /\bPOST:\s*\(\{\s*request\s*\}\)\s*=>\s*handleLogoutPostRequest\(request\)/
    );
    expect(logoutPage).not.toContain('signOut(');
    expect(logoutPage).not.toContain('useEffect');
    expect(confirmSignOut).not.toContain("to: '/logout'");
    expect(confirmSignOut).toContain('signOut()');
    expect(confirmSignOut).toContain('clearAllQueryStateForAuthBoundary');
  });

  it('blocks direct declarative navigation to protected side-effect routes', () => {
    expect(findDirectProtectedNavigationViolations()).toEqual([]);
  });

  it('parses static protected targets without matching comments or strings', () => {
    const source = [
      'const jsx = <Link to="/logout" />;',
      'const options = { "to": "/logout" };',
      'const expression = <Link to={"/logout"} />;',
      '// const ignored = { to: "/logout" };',
      'const ignoredText = "to: /logout";',
    ].join('\n');

    expect(
      findStaticProtectedNavigationLocations('fixture.tsx', source)
    ).toEqual(['fixture.tsx:1', 'fixture.tsx:2', 'fixture.tsx:3']);
  });

  it('routes platform button links through BridgeLink', () => {
    const buttonLink = readSource(
      path.join(root, 'src', 'platform', 'components', 'ui', 'button-link.tsx')
    );

    expect(buttonLink).toContain('@/platform/router');
    expect(buttonLink).toContain('BridgeLink');
    expect(buttonLink).not.toContain('@tanstack/react-router');
  });

  it('keeps presentation schemas free of i18n imports', () => {
    const schemaFiles = listSourceFiles(path.join(root, 'src/modules')).filter(
      (file) => file.endsWith(path.join('presentation', 'schema.ts'))
    );

    expect(
      findImportViolations(
        schemaFiles,
        /from\s+['"](?:i18next|react-i18next)['"]/g
      )
    ).toEqual([]);
  });

  it('keeps transport entry points thin', () => {
    const moduleTransportFiles = listSourceFiles(
      path.join(root, 'src/modules')
    ).filter((file) => file.includes(`${path.sep}transport${path.sep}`));
    const serverEntrypointFiles = listSourceFiles(
      path.join(root, 'src/modules')
    )
      .filter((file) => /[/\\](server|server-functions)\.ts$/.test(file))
      .filter(isServerFunctionEntrypoint);
    const apiRouteFiles = listSourceFiles(path.join(root, 'src/routes/api'));

    expect(
      findImportViolations(
        moduleTransportFiles,
        /from\s+['"]@\/composition(?:\/[^'"]*)?['"]/g
      )
    ).toEqual([]);
    expect(
      findImportViolations(
        [...moduleTransportFiles, ...serverEntrypointFiles, ...apiRouteFiles],
        /from\s+['"]@\/modules\/(?!kernel)[^/'"]+\/(?:infrastructure|presentation)(?:\/[^'"]*)?['"]/g
      )
    ).toEqual([]);
    expect(
      findImportViolations(
        [...moduleTransportFiles, ...serverEntrypointFiles, ...apiRouteFiles],
        /from\s+['"](?:drizzle-orm(?:\/[^'"]*)?|pg|postgres)['"]/g
      )
    ).toEqual([]);
  });

  it('confines Drizzle imports to persistence infrastructure', () => {
    const files = listSourceFiles(path.join(root, 'src')).filter((file) => {
      const relative = path.relative(root, file);
      return !isDrizzleImportAllowedSource(relative);
    });

    expect(
      findImportViolations(
        files,
        /(?:from\s+['"]|import\s*\(\s*['"])(?:drizzle-orm(?:\/[^'"]*)?|better-auth\/adapters\/drizzle(?:\/[^'"]*)?)['"]/g
      )
    ).toEqual([]);
  });

  it('keeps TanStack server functions assigned to named variables', () => {
    const files = listSourceFiles(path.join(root, 'src'));

    expect(findImportViolations(files, /:\s*createServerFn\s*\(/g)).toEqual([]);
    expect(
      findImportViolations(
        files,
        /^[\t ]*const\s+\w+\s*=\s*createServerFn\s*\(/gm
      )
    ).toEqual([]);
  });

  it('keeps module server barrels dedicated to server functions', () => {
    const violations = listSourceFiles(path.join(root, 'src/modules'))
      .filter((file) => /[/\\]modules[/\\][^/\\]+[/\\]server\.ts$/.test(file))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const relative = path.relative(root, file);
        const allowedServerFnSupportReexport =
          relative === path.join('src', 'modules', 'kernel', 'server.ts')
            ? /^export\s+\{[\s\S]*?\}\s+from\s+['"]\.\/transport\/tanstack\/server-fn-error['"];?\n?/m
            : undefined;
        const sourceWithoutAllowedSupport = allowedServerFnSupportReexport
          ? source.replace(allowedServerFnSupportReexport, '')
          : source;
        const reexportsServerFunctions =
          /^export\s+\*\s+from\s+['"]\.\/transport\/server-functions\/server-functions['"];?$/.test(
            sourceWithoutAllowedSupport.trim()
          );
        const definesServerFunction =
          sourceWithoutAllowedSupport.includes('createServerFn') &&
          !/export\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];/.test(
            sourceWithoutAllowedSupport
          );

        return reexportsServerFunctions || definesServerFunction
          ? []
          : [relative];
      });

    expect(violations).toEqual([]);
  });

  it('requires privileged server functions to use protected runners', () => {
    const publicServerFunctions = new Set([
      'configEnv',
      'currentSession',
      'initSsrApp',
    ]);
    const serverFiles = listSourceFiles(path.join(root, 'src/modules')).filter(
      (file) => /[/\\](server|server-functions)\.ts$/.test(file)
    );

    expect(
      findPrivilegedServerFunctionRunnerViolations(
        serverFiles,
        publicServerFunctions
      )
    ).toEqual([]);
  });

  it('confines Better Auth imports to auth boundaries', () => {
    const files = listSourceFiles(path.join(root, 'src')).filter((file) => {
      const relative = path.relative(root, file);
      return (
        !relative.startsWith(
          path.join('src', 'modules', 'auth', 'infrastructure', 'better-auth')
        ) &&
        relative !==
          path.join(
            'src',
            'modules',
            'auth',
            'presentation',
            'better-auth-client.ts'
          )
      );
    });

    expect(
      findImportViolations(files, /from\s+['"]better-auth(?:\/[^'"]*)?['"]/g)
    ).toEqual([]);
  });

  it('keeps provider session tokens out of app-facing code', () => {
    const files = listSourceFiles(path.join(root, 'src')).filter((file) => {
      const relative = path.relative(root, file);
      return !relative.startsWith(
        path.join('src', 'modules', 'auth', 'infrastructure', 'better-auth')
      );
    });

    expect(findImportViolations(files, /\bproviderToken\b/g)).toEqual([]);
  });

  it('keeps provider token fields out of client-facing route and presentation code', () => {
    const files = [
      ...listSourceFiles(path.join(root, 'src', 'routes')),
      ...listSourceFiles(path.join(root, 'src', 'modules')).filter((file) =>
        file.includes(`${path.sep}presentation${path.sep}`)
      ),
    ];

    expect(
      findImportViolations(
        files,
        /\b(?:accessToken|refreshToken|idToken|sessionToken)\b/g
      )
    ).toEqual([]);
  });

  it('reserves WorkOS SDK imports for the future WorkOS adapter', () => {
    const files = listSourceFiles(path.join(root, 'src')).filter((file) => {
      const relative = path.relative(root, file);
      return !relative.startsWith(
        path.join('src', 'modules', 'auth', 'infrastructure', 'workos')
      );
    });

    expect(
      findImportViolations(files, /from\s+['"]@workos(?:-inc)?\//g)
    ).toEqual([]);
  });

  it('keeps business code off the Sentry SDK', () => {
    const files = fs
      .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const moduleRoot = path.join(root, 'src/modules', entry.name);
        return [
          ...listSourceFiles(path.join(moduleRoot, 'domain')),
          ...listSourceFiles(path.join(moduleRoot, 'application')),
        ];
      });

    expect(findImportViolations(files, /from\s+['"]@sentry\//g)).toEqual([]);
  });

  it('keeps module application flow on Result instead of thrown errors', () => {
    const applicationFiles = fs
      .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        listSourceFiles(
          path.join(root, 'src/modules', entry.name, 'application')
        )
      );

    expect(findImportViolations(applicationFiles, /\bthrow\b/g)).toEqual([]);

    const tryCatchFiles = findImportViolations(
      applicationFiles,
      /\btry\s*\{[\s\S]*?\}\s*catch\b/g
    );
    const unexpectedTryCatchFiles = tryCatchFiles.filter(
      (file) => !transactionApplicationErrorBoundaryFiles.has(file)
    );

    expect(unexpectedTryCatchFiles).toEqual([]);
    expect(tryCatchFiles.sort()).toEqual(
      [...transactionApplicationErrorBoundaryFiles].sort()
    );
  });

  it('detects nested nullable, optional, and boolean port Promise payloads', () => {
    const source = `
      interface ExamplePort {
        directBoolean(): Promise<boolean>;
        nestedBoolean(): Promise<Result<boolean, AppError>>;
        nestedNullable(): Promise<Result<User | null, AppError>>;
        nestedOptional(): Promise<Result<Option<User | undefined>, AppError>>;
      }
    `;

    expect(findPortPromiseOutcomeOffenders(source)).toEqual([
      'nullable',
      'optional',
      'boolean',
    ]);
  });

  it('keeps application ports on tagged Result outcomes, not nullable or boolean', () => {
    const portFiles = fs
      .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        listSourceFiles(
          path.join(root, 'src/modules', entry.name, 'application', 'ports')
        )
      );

    const violations = portFiles.flatMap((file) => {
      const source = readSource(file);
      const offenders = findPortPromiseOutcomeOffenders(source, file);
      return offenders.length
        ? [`${relativePath(file)} (${offenders.join(', ')})`]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps application use cases free of match-then-if intermediate error objects', () => {
    const applicationFiles = fs
      .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        listSourceFiles(
          path.join(root, 'src/modules', entry.name, 'application')
        )
      );

    // The match-then-if anti-pattern mapped a Result.Error into a throwaway
    // tagged object (`(error) => ({ type: 'error' as const, error })`) and then
    // re-inspected it with `if (x.type === 'error')`, defeating ts-pattern's
    // exhaustiveness. Return Result.Error(x.getError()) or match the Result
    // directly instead.
    const violations = findImportViolations(
      applicationFiles,
      /type:\s*'error'\s+as\s+const/g
    );

    expect(violations).toEqual([]);
  });

  it('keeps Boxed values out of route modules', () => {
    const routeFiles = listSourceFiles(path.join(root, 'src/routes'));

    const violations = findImportViolations(
      routeFiles,
      /from\s+['"]@swan-io\/boxed['"]/g
    );

    expect(violations).toEqual([]);
  });
});
