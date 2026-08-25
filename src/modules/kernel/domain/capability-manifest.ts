import { z } from 'zod';

import {
  runtimeProfiles,
  type RuntimeProfile,
} from '@/platform/runtime/runtime-profile';

export const capabilityPresets = ['core', 'demo'] as const;
export type CapabilityPreset = (typeof capabilityPresets)[number];

export const manifestRuntimeProfiles = runtimeProfiles;
export type ManifestRuntimeProfile = RuntimeProfile;

export const runtimeAdapterKeys = [
  'database',
  'object-storage',
  'email-delivery',
  'trusted-client-ip',
  'lifecycle',
  'rate-limiting',
  'telemetry',
] as const;
export type RuntimeAdapterKey = (typeof runtimeAdapterKeys)[number];

export type CapabilityRouteAccess =
  | Readonly<{ kind: 'public' | 'authenticated' | 'development-only' }>
  | Readonly<{ kind: 'permission'; resource: string; action: string }>;

export type CapabilityRoute = Readonly<{
  access: CapabilityRouteAccess;
  file: string;
  kind: 'page' | 'api' | 'layout';
  routeId: `/${string}`;
}>;

export type CapabilitySchemaOwnership = Readonly<{
  kind: 'table' | 'enum';
  name: string;
  gate: `@/modules/${string}/persistence`;
  exportName: string;
}>;

export type CapabilitySchemaReference = Readonly<{
  capability: string;
  object: string;
}>;

export type CapabilityNavigationContribution = Readonly<{
  id: string;
  label: Readonly<{ key: string; namespace: string }>;
  order: number;
  routeId: `/${string}`;
  surface: 'app-primary' | 'manager-sidebar' | 'manager-user-menu';
}>;

export type CapabilityPermissionResource = Readonly<{
  actions: readonly string[];
  resource: string;
}>;

export type CapabilityRoleGrant = Readonly<{
  actions: readonly string[];
  resource: string;
  role: 'admin' | 'user';
}>;

export type CapabilityExportContribution = Readonly<{
  exportName: string;
  gate: string;
  id: string;
}>;

export type CapabilitySeedContribution = Readonly<{
  exportName: string;
  id: string;
  purpose: CapabilityPreset;
  sourceFile: string;
}>;

export type CapabilityTranslation = Readonly<{
  files: Readonly<Record<'ar' | 'en' | 'fr' | 'sw', string>>;
  namespace: string;
}>;

export type CapabilityRuntimeAdapterRequirement = Readonly<{
  key: RuntimeAdapterKey;
  profiles: readonly ManifestRuntimeProfile[];
  required: 'always' | 'when-enabled';
}>;

export type CapabilityManifest = Readonly<{
  backgroundJobs: readonly CapabilityExportContribution[];
  dependsOn: readonly string[];
  forms: readonly CapabilityExportContribution[];
  id: string;
  navigation: readonly CapabilityNavigationContribution[];
  ownedPaths: readonly string[];
  permissions: Readonly<{
    presetRoleGrants: readonly CapabilityRoleGrant[];
    resources: readonly CapabilityPermissionResource[];
  }>;
  preset: CapabilityPreset;
  publicRoutes: readonly CapabilityRoute[];
  removable: boolean;
  runtimeAdapters: readonly CapabilityRuntimeAdapterRequirement[];
  schema: Readonly<{
    owns: readonly CapabilitySchemaOwnership[];
    references: readonly CapabilitySchemaReference[];
  }>;
  seeds: readonly CapabilitySeedContribution[];
  translations: readonly CapabilityTranslation[];
  version: 1;
}>;

export class CapabilityManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityManifestError';
  }
}

const capabilityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const descriptorIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const schemaObjectNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;
const exportNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const forbiddenPathCharacterPattern = /[*?[\]{}]/u;
const protectedOwnedPaths = new Set([
  'AGENTS.md',
  'CONTEXT.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'src/routeTree.gen.ts',
  'src/server.ts',
  'src/start.ts',
]);

const hasForbiddenPathCodePoint = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

/** Lexical validation only; lifecycle commands must separately authorize targets. */
export const isSyntacticallySafeOwnedPath = (value: string) => {
  if (!value || value.startsWith('/') || value.startsWith('./')) return false;
  if (
    value.includes('\\') ||
    hasForbiddenPathCodePoint(value) ||
    forbiddenPathCharacterPattern.test(value)
  ) {
    return false;
  }
  if (
    value === '.git' ||
    value.startsWith('.git/') ||
    value === '.github' ||
    value.startsWith('.github/') ||
    value === 'drizzle/migrations' ||
    value.startsWith('drizzle/migrations/') ||
    protectedOwnedPaths.has(value) ||
    value.split('/').some((segment) => segment.startsWith('.env'))
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

const capabilityIdSchema = z.string().min(2).max(48).regex(capabilityIdPattern);
const descriptorIdSchema = z.string().regex(descriptorIdPattern);
const ownedPathSchema = z
  .string()
  .refine(isSyntacticallySafeOwnedPath, 'unsafe owned path');
const exportNameSchema = z.string().regex(exportNamePattern);
const schemaObjectNameSchema = z.string().regex(schemaObjectNamePattern);
const gateSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'gate must already be trimmed')
  .regex(
    /^@\/modules\/[a-z][a-z0-9-]*\/(?:backend|client|presentation|server)$/u,
    'expected a focused module public gate'
  );
const routeIdSchema = z.custom<`/${string}`>(
  (value) =>
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('?') &&
    !value.includes('#'),
  'expected an absolute TanStack route ID'
);

const exportContributionSchema = z.strictObject({
  exportName: exportNameSchema,
  gate: gateSchema,
  id: descriptorIdSchema,
});

const seedContributionSchema = z.strictObject({
  exportName: exportNameSchema,
  id: descriptorIdSchema,
  purpose: z.enum(capabilityPresets),
  sourceFile: ownedPathSchema,
});

const routeAccessSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.enum(['public', 'authenticated', 'development-only']),
  }),
  z.strictObject({
    action: descriptorIdSchema,
    kind: z.literal('permission'),
    resource: descriptorIdSchema,
  }),
]);

const schemaOwnershipSchema = z.strictObject({
  exportName: exportNameSchema,
  gate: z.custom<`@/modules/${string}/persistence`>(
    (value) =>
      typeof value === 'string' &&
      /^@\/modules\/[a-z][a-z0-9-]*\/persistence$/u.test(value),
    'expected a focused module persistence gate'
  ),
  kind: z.enum(['table', 'enum']),
  name: schemaObjectNameSchema,
});

const capabilityManifestSchema = z.strictObject({
  backgroundJobs: z.array(exportContributionSchema),
  dependsOn: z.array(capabilityIdSchema),
  forms: z.array(exportContributionSchema),
  id: capabilityIdSchema,
  navigation: z.array(
    z.strictObject({
      id: descriptorIdSchema,
      label: z.strictObject({
        key: descriptorIdSchema,
        namespace: descriptorIdSchema,
      }),
      order: z.number().int().nonnegative(),
      routeId: routeIdSchema,
      surface: z.enum(['app-primary', 'manager-sidebar', 'manager-user-menu']),
    })
  ),
  ownedPaths: z.array(ownedPathSchema),
  permissions: z.strictObject({
    presetRoleGrants: z.array(
      z.strictObject({
        actions: z.array(descriptorIdSchema),
        resource: descriptorIdSchema,
        role: z.enum(['admin', 'user']),
      })
    ),
    resources: z.array(
      z.strictObject({
        actions: z.array(descriptorIdSchema).min(1),
        resource: descriptorIdSchema,
      })
    ),
  }),
  preset: z.enum(capabilityPresets),
  publicRoutes: z.array(
    z.strictObject({
      access: routeAccessSchema,
      file: ownedPathSchema,
      kind: z.enum(['page', 'api', 'layout']),
      routeId: routeIdSchema,
    })
  ),
  removable: z.boolean(),
  runtimeAdapters: z.array(
    z.strictObject({
      key: z.enum(runtimeAdapterKeys),
      profiles: z.array(z.enum(manifestRuntimeProfiles)).min(1),
      required: z.enum(['always', 'when-enabled']),
    })
  ),
  schema: z.strictObject({
    owns: z.array(schemaOwnershipSchema),
    references: z.array(
      z.strictObject({
        capability: capabilityIdSchema,
        object: schemaObjectNameSchema,
      })
    ),
  }),
  seeds: z.array(seedContributionSchema),
  translations: z.array(
    z.strictObject({
      files: z.strictObject({
        ar: ownedPathSchema,
        en: ownedPathSchema,
        fr: ownedPathSchema,
        sw: ownedPathSchema,
      }),
      namespace: descriptorIdSchema,
    })
  ),
  version: z.literal(1),
});

const assertManifest: (
  condition: unknown,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) throw new CapabilityManifestError(message);
};

const assertUnique = (values: readonly string[], label: string) => {
  const seen = new Set<string>();
  for (const value of values) {
    assertManifest(!seen.has(value), `${label} contains duplicate: ${value}`);
    seen.add(value);
  }
};

const validateContributionGroup = (
  values: readonly Readonly<{ id: string }>[],
  label: string
) =>
  assertUnique(
    values.map(({ id }) => id),
    `${label} IDs`
  );

const validateExportContributionGates = (
  manifest: CapabilityManifest,
  values: readonly CapabilityExportContribution[],
  allowedGates: readonly string[],
  label: string
) => {
  for (const value of values) {
    const match = /^@\/modules\/([^/]+)\/([^/]+)$/u.exec(value.gate);
    const capability = match?.[1];
    const gate = match?.[2];
    assertManifest(
      capability && gate,
      `${manifest.id} ${label} must use a focused module public gate: ${value.gate}`
    );
    assertManifest(
      capability === manifest.id || manifest.dependsOn.includes(capability),
      `${manifest.id} ${label} gate must be owned or declared as a dependency: ${capability}`
    );
    assertManifest(
      allowedGates.includes(gate),
      `${manifest.id} ${label} cannot use the ${gate} gate`
    );
  }
};

const validatePermissions = (manifest: CapabilityManifest) => {
  const resourceActions = new Map<string, Set<string>>();
  for (const contribution of manifest.permissions.resources) {
    assertUnique(
      contribution.actions,
      `Permission actions for ${contribution.resource}`
    );
    assertManifest(
      !resourceActions.has(contribution.resource),
      `Permission resource is duplicated: ${contribution.resource}`
    );
    resourceActions.set(contribution.resource, new Set(contribution.actions));
  }

  const grantKeys: string[] = [];
  for (const grant of manifest.permissions.presetRoleGrants) {
    grantKeys.push(`${grant.role}:${grant.resource}`);
    const actions = resourceActions.get(grant.resource);
    assertManifest(
      actions,
      `Role grant references unowned permission resource: ${grant.resource}`
    );
    assertUnique(grant.actions, `Role grant actions for ${grant.resource}`);
    for (const action of grant.actions) {
      assertManifest(
        actions.has(action),
        `Role grant references unknown ${grant.resource} action: ${action}`
      );
    }
  }
  assertUnique(grantKeys, `${manifest.id} role grants`);
};

const validateOwnedContributions = (manifest: CapabilityManifest) => {
  const ownedPaths = new Set(manifest.ownedPaths);
  const declarativePaths = [
    ...manifest.publicRoutes.map(({ file }) => file),
    ...manifest.translations.flatMap(({ files }) => Object.values(files)),
    ...manifest.seeds.map(({ sourceFile }) => sourceFile),
  ];
  for (const path of declarativePaths) {
    assertManifest(
      ownedPaths.has(path),
      `${manifest.id} contribution is missing from ownedPaths: ${path}`
    );
  }

  for (const path of manifest.ownedPaths) {
    const moduleMatch = /^src\/modules\/([^/]+)(?:\/|$)/u.exec(path);
    assertManifest(
      !moduleMatch || moduleMatch[1] === manifest.id,
      `${manifest.id} cannot own another capability path: ${path}`
    );
  }
};

const parseManifestShape = (manifest: CapabilityManifest) => {
  try {
    assertManifest(
      typeof JSON.stringify(manifest) === 'string',
      'Capability manifest must serialize to JSON'
    );
  } catch (error) {
    if (error instanceof CapabilityManifestError) throw error;
    throw new CapabilityManifestError(
      'Capability manifest must serialize to JSON'
    );
  }
  const result = capabilityManifestSchema.safeParse(manifest);
  if (result.success) return;
  const issue = result.error.issues[0];
  const location = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new CapabilityManifestError(
    `${location}${issue?.message ?? 'Invalid capability manifest'}`
  );
};

export const validateCapabilityManifest = (manifest: CapabilityManifest) => {
  parseManifestShape(manifest);
  assertManifest(
    manifest.removable === (manifest.preset === 'demo'),
    `Capability removability must match its preset: ${manifest.id}`
  );
  assertUnique(manifest.dependsOn, `${manifest.id} dependencies`);
  assertManifest(
    manifest.dependsOn
      .toSorted()
      .every((dependency, index) => dependency === manifest.dependsOn[index]),
    `${manifest.id} dependencies must be sorted`
  );
  assertManifest(
    !manifest.dependsOn.includes(manifest.id),
    `Capability cannot depend on itself: ${manifest.id}`
  );
  assertUnique(
    manifest.publicRoutes.map(({ routeId }) => routeId),
    `${manifest.id} route IDs`
  );
  assertUnique(
    manifest.publicRoutes.map(({ file }) => file),
    `${manifest.id} route files`
  );
  assertUnique(
    manifest.schema.owns.map(({ name }) => name),
    `${manifest.id} schema objects`
  );
  validatePermissions(manifest);
  assertUnique(
    manifest.navigation.map(({ id }) => id),
    `${manifest.id} navigation IDs`
  );
  for (const navigation of manifest.navigation) {
    assertManifest(
      manifest.publicRoutes.some(
        ({ routeId }) => routeId === navigation.routeId
      ),
      `${manifest.id} navigation references an unknown route: ${navigation.routeId}`
    );
  }
  validateContributionGroup(manifest.seeds, `${manifest.id} seed`);
  for (const seed of manifest.seeds) {
    assertManifest(
      manifest.preset === 'core' || seed.purpose === 'demo',
      `Demo capability cannot contribute a core seed: ${seed.id}`
    );
  }
  validateContributionGroup(manifest.forms, `${manifest.id} form`);
  validateContributionGroup(manifest.backgroundJobs, `${manifest.id} job`);
  validateExportContributionGates(
    manifest,
    manifest.forms,
    ['client', 'presentation'],
    'form'
  );
  validateExportContributionGates(
    manifest,
    manifest.backgroundJobs,
    ['backend', 'server'],
    'background job'
  );
  assertUnique(
    manifest.translations.map(({ namespace }) => namespace),
    `${manifest.id} translation namespaces`
  );
  assertUnique(
    manifest.runtimeAdapters.map(({ key }) => key),
    `${manifest.id} runtime adapters`
  );
  for (const adapter of manifest.runtimeAdapters) {
    assertUnique(adapter.profiles, `${manifest.id} ${adapter.key} profiles`);
  }
  assertUnique(manifest.ownedPaths, `${manifest.id} owned paths`);
  validateOwnedContributions(manifest);
  return manifest;
};

export const defineCapabilityManifest = <
  const TManifest extends CapabilityManifest,
>(
  manifest: TManifest
) => {
  validateCapabilityManifest(manifest);
  return manifest;
};

const assertAcyclicDependencies = (
  manifestsById: ReadonlyMap<string, CapabilityManifest>
) => {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return;
    assertManifest(
      !visiting.has(id),
      `Capability dependency cycle includes: ${id}`
    );
    visiting.add(id);
    for (const dependency of manifestsById.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of manifestsById.keys()) visit(id);
};

const assertGloballyUniqueContributions = (
  manifests: readonly CapabilityManifest[]
) => {
  const assertManifestValues = (
    label: string,
    select: (manifest: CapabilityManifest) => readonly string[]
  ) => assertUnique(manifests.flatMap(select), label);

  assertManifestValues('Registry route IDs', ({ publicRoutes }) =>
    publicRoutes.map(({ routeId }) => routeId)
  );
  assertManifestValues('Registry route files', ({ publicRoutes }) =>
    publicRoutes.map(({ file }) => file)
  );
  assertManifestValues('Registry owned paths', ({ ownedPaths }) => ownedPaths);
  assertManifestValues('Registry permission resources', ({ permissions }) =>
    permissions.resources.map(({ resource }) => resource)
  );
  assertManifestValues('Registry translation namespaces', ({ translations }) =>
    translations.map(({ namespace }) => namespace)
  );
  assertManifestValues('Registry schema objects', ({ schema }) =>
    schema.owns.map(({ name }) => name)
  );
  assertManifestValues('Registry navigation IDs', ({ navigation }) =>
    navigation.map(({ id }) => id)
  );
  for (const key of ['seeds', 'forms', 'backgroundJobs'] as const) {
    assertManifestValues(`Registry ${key} IDs`, (manifest) =>
      manifest[key].map(({ id }) => id)
    );
  }
};

const assertSchemaReferences = (
  manifestsById: ReadonlyMap<string, CapabilityManifest>
) => {
  for (const manifest of manifestsById.values()) {
    for (const owned of manifest.schema.owns) {
      assertManifest(
        owned.gate === `@/modules/${manifest.id}/persistence`,
        `${manifest.id} schema object must use its own persistence gate: ${owned.name}`
      );
    }
    for (const reference of manifest.schema.references) {
      const owner = manifestsById.get(reference.capability);
      assertManifest(
        owner,
        `${manifest.id} references unknown capability: ${reference.capability}`
      );
      assertManifest(
        owner.schema.owns.some(({ name }) => name === reference.object),
        `${manifest.id} references unknown schema object: ${reference.capability}.${reference.object}`
      );
      assertManifest(
        manifest.dependsOn.includes(reference.capability),
        `${manifest.id} schema reference must also be a dependency: ${reference.capability}`
      );
    }
  }
};

const assertRoutePermissions = (manifests: readonly CapabilityManifest[]) => {
  const resources = new Map(
    manifests.flatMap(({ id, permissions }) =>
      permissions.resources.map(
        ({ actions, resource }) =>
          [resource, { actions: new Set(actions), capability: id }] as const
      )
    )
  );
  for (const manifest of manifests) {
    for (const route of manifest.publicRoutes) {
      if (route.access.kind !== 'permission') continue;
      const owner = resources.get(route.access.resource);
      assertManifest(
        owner,
        `${manifest.id} route references unknown permission resource: ${route.access.resource}`
      );
      assertManifest(
        owner.actions.has(route.access.action),
        `${manifest.id} route references unknown permission: ${route.access.resource}.${route.access.action}`
      );
      assertManifest(
        owner.capability === manifest.id ||
          manifest.dependsOn.includes(owner.capability),
        `${manifest.id} route permission must also be a dependency: ${owner.capability}`
      );
    }
  }
};

const assertTopologicalOrder = (manifests: readonly CapabilityManifest[]) => {
  const positions = new Map(manifests.map(({ id }, index) => [id, index]));
  for (const [index, manifest] of manifests.entries()) {
    for (const dependency of manifest.dependsOn) {
      assertManifest(
        (positions.get(dependency) ?? Number.POSITIVE_INFINITY) < index,
        `${manifest.id} must follow dependency ${dependency} in the registry`
      );
    }
  }
};

export const defineCapabilityRegistry = <
  const TManifests extends readonly CapabilityManifest[],
>(
  manifests: TManifests
) => {
  assertUnique(
    manifests.map(({ id }) => id),
    'Capability registry IDs'
  );
  const manifestsById = new Map(
    manifests.map((manifest) => [manifest.id, manifest])
  );

  for (const manifest of manifests) {
    validateCapabilityManifest(manifest);
    for (const dependency of manifest.dependsOn) {
      const dependencyManifest = manifestsById.get(dependency);
      assertManifest(
        dependencyManifest,
        `${manifest.id} depends on unknown capability: ${dependency}`
      );
      assertManifest(
        manifest.preset !== 'core' || dependencyManifest.preset === 'core',
        `Core capability ${manifest.id} cannot depend on demo capability ${dependency}`
      );
    }
  }
  assertAcyclicDependencies(manifestsById);
  assertTopologicalOrder(manifests);
  assertGloballyUniqueContributions(manifests);
  assertSchemaReferences(manifestsById);
  assertRoutePermissions(manifests);
  return manifests;
};

export const selectDeclaredCapabilitiesForPreset = (
  manifests: readonly CapabilityManifest[],
  preset: CapabilityPreset
) =>
  manifests.filter(
    (manifest) => preset === 'demo' || manifest.preset === 'core'
  );
