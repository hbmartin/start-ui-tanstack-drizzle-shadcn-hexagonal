import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import ar from '@/app/i18n/ar';
import en from '@/app/i18n/en';
import fr from '@/app/i18n/fr';
import sw from '@/app/i18n/sw';
import {
  compileCapabilityNavigation,
  compileCapabilityPermissions,
  compileCapabilitySeeds,
  compileCapabilityTranslationNamespaces,
} from '@/composition/capabilities/compile';
import {
  capabilityRegistry,
  getDeclaredCapabilitiesForPreset,
} from '@/composition/capabilities/registry';
import {
  activeSeedPreset,
  seedContributionIds,
} from '../../drizzle/seed/registry.generated';
import {
  defaultUserPermissions,
  permissionStatements,
  rolePermissions,
} from '@/modules/auth';
import * as auditPersistence from '@/modules/audit/persistence';
import * as authClient from '@/modules/auth/client';
import * as authPersistence from '@/modules/auth/persistence';
import * as bookPersistence from '@/modules/book/persistence';
import * as bookPresentation from '@/modules/book/presentation';
import * as emailPersistence from '@/modules/email/persistence';
import * as genrePersistence from '@/modules/genre/persistence';
import * as profilePresentation from '@/modules/profile/presentation';
import * as userPresentation from '@/modules/user/presentation';

const root = process.cwd();
const localeRegistries = { ar, en, fr, sw } as const;
const publicExports: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  '@/modules/audit/persistence': auditPersistence,
  '@/modules/auth/client': authClient,
  '@/modules/auth/persistence': authPersistence,
  '@/modules/book/persistence': bookPersistence,
  '@/modules/book/presentation': bookPresentation,
  '@/modules/email/persistence': emailPersistence,
  '@/modules/genre/persistence': genrePersistence,
  '@/modules/profile/presentation': profilePresentation,
  '@/modules/user/presentation': userPresentation,
};

const readProjectFile = (file: string) =>
  fs.readFileSync(path.join(root, file), 'utf8');

const listSourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(file);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [file] : [];
  });

const getRouteId = (file: string) => {
  const match = /createFileRoute\(\s*['"]([^'"]+)['"]\s*\)/u.exec(
    readProjectFile(file)
  );
  return match?.[1];
};

const businessModuleIds = fs
  .readdirSync(path.join(root, 'src/modules'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'kernel')
  .map(({ name }) => name)
  .toSorted();

const schemaOwningManifests = capabilityRegistry.filter(
  ({ schema }) => schema.owns.length > 0
);

const getSchemaGate = (manifest: (typeof schemaOwningManifests)[number]) =>
  manifest.schema.owns[0]?.gate ?? '';

describe('capability manifest registry', () => {
  it('covers every module and remains plain JSON', () => {
    expect(capabilityRegistry.map(({ id }) => id).toSorted()).toEqual(
      businessModuleIds
    );
    for (const id of businessModuleIds) {
      expect(
        fs.existsSync(path.join(root, 'src/modules', id, 'manifest.ts'))
      ).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(capabilityRegistry))).toEqual(
      capabilityRegistry
    );
  });

  it('matches declared routes and owned files', () => {
    for (const manifest of capabilityRegistry) {
      for (const ownedPath of manifest.ownedPaths) {
        expect(fs.existsSync(path.join(root, ownedPath))).toBe(true);
      }
      for (const route of manifest.publicRoutes) {
        expect(getRouteId(route.file)).toBe(route.routeId);
      }
    }
  });

  it('matches declared public exports', () => {
    const contributions = capabilityRegistry.flatMap((manifest) => [
      ...manifest.schema.owns,
      ...manifest.forms,
      ...manifest.backgroundJobs,
    ]);
    for (const contribution of contributions) {
      expect(
        publicExports[contribution.gate]?.[contribution.exportName]
      ).toBeDefined();
    }
  });

  it('matches declared seed exports', () => {
    for (const manifest of capabilityRegistry) {
      for (const seed of manifest.seeds) {
        const source = readProjectFile(seed.sourceFile);
        expect(source).toMatch(
          new RegExp(
            `export\\s+(?:async\\s+)?function\\s+${seed.exportName}\\b`,
            'u'
          )
        );
      }
    }
  });

  it('keeps focused manifest and persistence gates narrow', () => {
    const kernelManifestSource = readProjectFile(
      'src/modules/kernel/manifest.ts'
    );
    const kernelImports = [
      ...kernelManifestSource.matchAll(/from\s+['"]([^'"]+)['"]/gu),
    ].map((match) => match[1]);
    expect(kernelImports.every((specifier) => specifier?.startsWith('.'))).toBe(
      true
    );

    for (const manifest of capabilityRegistry) {
      const manifestSource = readProjectFile(
        `src/modules/${manifest.id}/manifest.ts`
      );
      const externalImports = [
        ...manifestSource.matchAll(/from\s+['"]([^'"]+)['"]/gu),
      ].map((match) => match[1]);
      expect(externalImports).toEqual(['@/modules/kernel/manifest']);
    }

    for (const moduleId of ['audit', 'auth', 'book', 'email', 'genre']) {
      const persistenceSource = readProjectFile(
        `src/modules/${moduleId}/persistence.ts`
      );
      expect(persistenceSource).not.toContain('export *');
      expect(persistenceSource.match(/from\s+['"]([^'"]+)['"]/u)?.[1]).toBe(
        './infrastructure/drizzle/schema'
      );
    }

    for (const manifest of schemaOwningManifests) {
      const gate = getSchemaGate(manifest);
      expect(gate).not.toBe('');
      expect(
        Object.keys(
          publicExports[gate] as Readonly<Record<string, unknown>>
        ).toSorted()
      ).toEqual(
        manifest.schema.owns.map(({ exportName }) => exportName).toSorted()
      );
    }
  });

  it('provides the auth-owned user security adapter without a reverse capability edge', () => {
    const adapterSource = readProjectFile(
      'src/modules/auth/infrastructure/drizzle/user-security-repository-drizzle.ts'
    );
    const compositionSource = readProjectFile('src/composition/user.ts');

    expect(adapterSource).not.toMatch(/from\s+['"]@\/modules\/user/u);
    expect(compositionSource).toContain("from '@/modules/auth/administration'");
    expect(compositionSource).not.toMatch(
      /from\s+['"]@\/modules\/auth\/infrastructure/u
    );
    const consumers = listSourceFiles(path.join(root, 'src'))
      .filter((file) =>
        fs
          .readFileSync(file, 'utf8')
          .includes("from '@/modules/auth/administration'")
      )
      .map((file) => path.relative(root, file));
    expect(consumers).toEqual(['src/composition/user.ts']);
  });

  it('publishes the user-owned audited logout route through the user backend gate', () => {
    expect(readProjectFile('src/routes/logout.tsx')).toContain(
      "import('@/modules/user/backend')"
    );
    expect(readProjectFile('src/modules/user/backend.ts')).toContain(
      "from '@/composition/auth-sign-out'"
    );
    expect(readProjectFile('src/modules/auth/backend.ts')).not.toContain(
      'handleLogoutRequest'
    );
  });

  it('matches permission and locale registries during generated-file transition', () => {
    const compiled = compileCapabilityPermissions(capabilityRegistry);
    expect(compiled.statements).toEqual(permissionStatements);
    expect(compiled.rolePermissions).toEqual(rolePermissions);
    expect(compiled.defaultUserPermissions).toEqual(defaultUserPermissions);

    const namespaces =
      compileCapabilityTranslationNamespaces(capabilityRegistry);
    for (const locale of Object.values(localeRegistries)) {
      expect(
        namespaces.every((namespace) => Object.hasOwn(locale, namespace))
      ).toBe(true);
    }
  });

  it('keeps the generated seed registry aligned with the active preset', () => {
    expect(seedContributionIds).toEqual(
      compileCapabilitySeeds(capabilityRegistry, activeSeedPreset)
    );
    expect(compileCapabilitySeeds(capabilityRegistry, 'core')).toEqual([
      { capabilityId: 'user', id: 'user.local-accounts' },
    ]);
  });

  it('tracks navigation contributions still rendered by the app shell', () => {
    const sourceBySurface = {
      'app-primary': readProjectFile(
        'src/app/shell/presentation/app/main-nav-config.ts'
      ),
      'manager-sidebar': readProjectFile(
        'src/app/shell/presentation/manager/nav-sidebar.tsx'
      ),
      'manager-user-menu': readProjectFile(
        'src/app/shell/presentation/manager/nav-user.tsx'
      ),
    } as const;

    for (const contribution of compileCapabilityNavigation(
      capabilityRegistry
    )) {
      const source = sourceBySurface[contribution.surface];
      expect(source).toContain(contribution.routeId.replace(/\/$/u, ''));
      expect(source).toContain(
        `${contribution.label.namespace}:${contribution.label.key}`
      );
    }
  });

  it('keeps core independent of demo-only storage and preserves removal order', () => {
    const core = getDeclaredCapabilitiesForPreset('core');
    const demo = getDeclaredCapabilitiesForPreset('demo');
    expect(core.map(({ id }) => id)).toEqual([
      'audit',
      'email',
      'auth',
      'profile',
      'user',
    ]);
    expect(demo.map(({ id }) => id)).toEqual([
      'audit',
      'email',
      'auth',
      'profile',
      'user',
      'genre',
      'book',
    ]);
    expect(
      core
        .flatMap(({ runtimeAdapters }) => runtimeAdapters)
        .some(({ key }) => key === 'object-storage')
    ).toBe(false);
    expect(
      demo
        .flatMap(({ runtimeAdapters }) => runtimeAdapters)
        .some(({ key }) => key === 'object-storage')
    ).toBe(true);
    expect(demo.findIndex(({ id }) => id === 'genre')).toBeLessThan(
      demo.findIndex(({ id }) => id === 'book')
    );
  });
});
