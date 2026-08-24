import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const profileCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'profile',
  navigation: [
    {
      id: 'profile.app-primary',
      label: { namespace: 'layout', key: 'nav.profile' },
      order: 20,
      routeId: '/app/profile/',
      surface: 'app-primary',
    },
    {
      id: 'profile.manager-user-menu',
      label: { namespace: 'layout', key: 'nav.profile' },
      order: 10,
      routeId: '/manager/profile/',
      surface: 'manager-user-menu',
    },
  ],
  preset: 'core',
  removable: false,
  dependsOn: ['auth'],
  publicRoutes: [
    {
      routeId: '/app/profile/',
      file: 'src/routes/app/profile.index.tsx',
      kind: 'page',
      access: { kind: 'authenticated' },
    },
    {
      routeId: '/manager/profile/',
      file: 'src/routes/manager/profile.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
  ],
  schema: {
    owns: [],
    references: [{ capability: 'auth', object: 'user' }],
  },
  permissions: {
    resources: [{ resource: 'profile', actions: ['update'] }],
    presetRoleGrants: [
      { role: 'user', resource: 'profile', actions: ['update'] },
      { role: 'admin', resource: 'profile', actions: ['update'] },
    ],
  },
  seeds: [],
  translations: [
    {
      namespace: 'profile',
      files: {
        ar: 'src/app/i18n/ar/profile.json',
        en: 'src/app/i18n/en/profile.json',
        fr: 'src/app/i18n/fr/profile.json',
        sw: 'src/app/i18n/sw/profile.json',
      },
    },
  ],
  forms: [
    {
      id: 'profile.update-name',
      gate: '@/modules/profile/presentation',
      exportName: 'zFormFieldsProfileUpdateName',
    },
  ],
  backgroundJobs: [],
  runtimeAdapters: [
    {
      key: 'database',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'always',
    },
  ],
  ownedPaths: [
    'src/app/i18n/ar/profile.json',
    'src/app/i18n/en/profile.json',
    'src/app/i18n/fr/profile.json',
    'src/app/i18n/sw/profile.json',
    'src/composition/profile.ts',
    'src/routes/app/profile.index.tsx',
    'src/routes/manager/profile.index.tsx',
    'tsconfig.stryker.profile.json',
  ],
});
