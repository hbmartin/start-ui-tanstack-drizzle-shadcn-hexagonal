import { describe, expect, it } from 'vitest';

import {
  CapabilityManifestError,
  defineCapabilityManifest,
  defineCapabilityRegistry,
  isSyntacticallySafeOwnedPath,
  selectDeclaredCapabilitiesForPreset,
  type CapabilityManifest,
} from '@/modules/kernel/manifest';

const makeManifest = (
  overrides: Partial<CapabilityManifest> = {}
): CapabilityManifest => ({
  version: 1,
  id: 'example',
  preset: 'demo',
  removable: true,
  dependsOn: [],
  navigation: [],
  publicRoutes: [],
  schema: { owns: [], references: [] },
  permissions: { resources: [], presetRoleGrants: [] },
  seeds: [],
  translations: [],
  forms: [],
  backgroundJobs: [],
  runtimeAdapters: [],
  ownedPaths: [],
  ...overrides,
});

describe('capability manifests', () => {
  it('preserves literal data and rejects unknown or non-JSON fields', () => {
    const manifest = defineCapabilityManifest(makeManifest());
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);

    expect(() =>
      defineCapabilityManifest({
        ...makeManifest(),
        unexpected: true,
      } as unknown as CapabilityManifest)
    ).toThrow(CapabilityManifestError);
    expect(() =>
      defineCapabilityManifest({
        ...makeManifest(),
        forms: [{ id: 'bad.form', gate: () => true, exportName: 'zBad' }],
      } as unknown as CapabilityManifest)
    ).toThrow(CapabilityManifestError);
    expect(() =>
      defineCapabilityManifest({
        ...makeManifest(),
        navigation: [
          {
            id: 'bad.navigation',
            label: { key: 'nav.bad', namespace: 'layout' },
            order: 1n,
            routeId: '/bad/',
            surface: 'app-primary',
          },
        ],
      } as unknown as CapabilityManifest)
    ).toThrow(/serialize to JSON/u);
  });

  it('restricts contributions to owned or dependency public gates', () => {
    expect(() =>
      defineCapabilityManifest(
        makeManifest({
          forms: [
            {
              id: 'example.form',
              gate: '@/modules/example/domain/schema',
              exportName: 'zExample',
            },
          ],
        })
      )
    ).toThrow(/focused module public gate/u);
    expect(() =>
      defineCapabilityManifest(
        makeManifest({
          forms: [
            {
              id: 'example.form',
              gate: '@/modules/auth/presentation',
              exportName: 'zExample',
            },
          ],
        })
      )
    ).toThrow(/declared as a dependency/u);
  });

  it.each([
    '/absolute.ts',
    './relative.ts',
    '../escape.ts',
    'src/../escape.ts',
    'src\\module.ts',
    'src/**/module.ts',
    '.git/config',
    '.github/workflows/check.yml',
    'drizzle/migrations/0001.sql',
    '.env.production',
    'AGENTS.md',
    'package.json',
    'src/start.ts',
    'src/routes/\u202eevil.ts',
  ])('rejects unsafe ownership path %s', (path) => {
    expect(isSyntacticallySafeOwnedPath(path)).toBe(false);
    expect(() =>
      defineCapabilityManifest(makeManifest({ ownedPaths: [path] }))
    ).toThrow(CapabilityManifestError);
  });

  it('rejects duplicate declarations and invalid role grants', () => {
    const route = {
      routeId: '/example/' as const,
      file: 'src/routes/example/index.tsx',
      kind: 'page' as const,
      access: { kind: 'public' as const },
    };
    expect(() =>
      defineCapabilityManifest(
        makeManifest({
          publicRoutes: [route, { ...route, routeId: '/other/' }],
          ownedPaths: [route.file],
        })
      )
    ).toThrow(/route files.*duplicate/u);
    expect(() =>
      defineCapabilityManifest(
        makeManifest({
          permissions: {
            resources: [{ resource: 'example', actions: ['read'] }],
            presetRoleGrants: [
              { role: 'user', resource: 'example', actions: ['write'] },
            ],
          },
        })
      )
    ).toThrow(/unknown example action/u);
  });

  it('validates dependency, schema-reference, and permission graphs', () => {
    const core = makeManifest({
      id: 'core',
      preset: 'core',
      removable: false,
      permissions: {
        resources: [{ resource: 'apps', actions: ['manager'] }],
        presetRoleGrants: [],
      },
      schema: {
        owns: [
          {
            kind: 'table',
            name: 'principal',
            gate: '@/modules/core/persistence',
            exportName: 'principal',
          },
        ],
        references: [],
      },
    });
    const demo = makeManifest({
      id: 'demo',
      dependsOn: ['core'],
      publicRoutes: [
        {
          routeId: '/demo/',
          file: 'src/routes/demo/index.tsx',
          kind: 'page',
          access: { kind: 'permission', resource: 'apps', action: 'manager' },
        },
      ],
      schema: {
        owns: [],
        references: [{ capability: 'core', object: 'principal' }],
      },
      ownedPaths: ['src/routes/demo/index.tsx'],
    });

    expect(defineCapabilityRegistry([core, demo])).toEqual([core, demo]);
    expect(() =>
      defineCapabilityRegistry([
        core,
        makeManifest({ id: 'broken', dependsOn: ['missing'] }),
      ])
    ).toThrow(/unknown capability/u);
    expect(() =>
      defineCapabilityRegistry([
        core,
        makeManifest({
          id: 'broken',
          dependsOn: ['core'],
          schema: {
            owns: [],
            references: [{ capability: 'core', object: 'missing' }],
          },
        }),
      ])
    ).toThrow(/unknown schema object/u);
    expect(() =>
      defineCapabilityRegistry([
        makeManifest({ id: 'first', dependsOn: ['second'] }),
        makeManifest({ id: 'second', dependsOn: ['first'] }),
      ])
    ).toThrow(/cycle/u);
    expect(() =>
      defineCapabilityRegistry([
        demo,
        makeManifest({
          id: 'core',
          preset: 'core',
          removable: false,
          dependsOn: ['demo'],
        }),
      ])
    ).toThrow(/cannot depend on demo/u);
  });

  it('requires dependency IDs in canonical code-point order', () => {
    expect(
      defineCapabilityManifest(makeManifest({ dependsOn: ['alpha', 'zeta'] }))
        .dependsOn
    ).toEqual(['alpha', 'zeta']);
    expect(() =>
      defineCapabilityManifest(makeManifest({ dependsOn: ['zeta', 'alpha'] }))
    ).toThrow(/dependencies must be sorted/u);
  });

  it('selects exact core and demo preset membership', () => {
    const core = makeManifest({ id: 'core', preset: 'core', removable: false });
    const demo = makeManifest({ id: 'demo' });
    expect(selectDeclaredCapabilitiesForPreset([core, demo], 'core')).toEqual([
      core,
    ]);
    expect(selectDeclaredCapabilitiesForPreset([core, demo], 'demo')).toEqual([
      core,
      demo,
    ]);
  });
});
