import type {
  CapabilityManifest,
  CapabilityNavigationContribution,
  CapabilityPreset,
} from '@/modules/kernel/manifest';

type CompiledPermissions = Readonly<{
  defaultUserPermissions: Readonly<Record<string, readonly string[]>>;
  rolePermissions: Readonly<
    Record<'admin' | 'user', Readonly<Record<string, readonly string[]>>>
  >;
  statements: Readonly<Record<string, readonly string[]>>;
}>;

export const compileCapabilityPermissions = (
  manifests: readonly CapabilityManifest[]
): CompiledPermissions => {
  const statements: Record<string, readonly string[]> = {};
  const rolePermissions: Record<
    'admin' | 'user',
    Record<string, readonly string[]>
  > = { admin: {}, user: {} };

  for (const manifest of manifests) {
    for (const { actions, resource } of manifest.permissions.resources) {
      statements[resource] = actions;
      rolePermissions.admin[resource] = [];
      rolePermissions.user[resource] = [];
    }
    for (const { actions, resource, role } of manifest.permissions
      .presetRoleGrants) {
      rolePermissions[role][resource] = actions;
    }
  }

  return {
    statements,
    rolePermissions,
    defaultUserPermissions: Object.fromEntries(
      Object.entries(rolePermissions.user).filter(
        ([, actions]) => actions.length > 0
      )
    ),
  };
};

export const compileCapabilityNavigation = (
  manifests: readonly CapabilityManifest[]
): readonly CapabilityNavigationContribution[] =>
  manifests
    .flatMap(({ navigation }) => navigation)
    .toSorted(
      (left, right) =>
        left.surface.localeCompare(right.surface) ||
        left.order - right.order ||
        left.id.localeCompare(right.id)
    );

export const compileCapabilityTranslationNamespaces = (
  manifests: readonly CapabilityManifest[]
) =>
  manifests.flatMap(({ translations }) =>
    translations.map(({ namespace }) => namespace)
  );

export const compileCapabilitySeeds = (
  manifests: readonly CapabilityManifest[],
  preset: CapabilityPreset
) =>
  manifests
    .filter((manifest) => preset === 'demo' || manifest.preset === 'core')
    .flatMap((manifest) =>
      manifest.seeds
        .filter((seed) => preset === 'demo' || seed.purpose === 'core')
        .map((seed) => ({ capabilityId: manifest.id, id: seed.id }))
    );
