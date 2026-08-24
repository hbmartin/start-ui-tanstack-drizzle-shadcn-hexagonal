import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const userCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'user',
  navigation: [
    {
      id: 'user.manager-sidebar',
      label: { namespace: 'layout', key: 'nav.users' },
      order: 20,
      routeId: '/manager/users/',
      surface: 'manager-sidebar',
    },
  ],
  preset: 'core',
  removable: false,
  dependsOn: ['auth'],
  publicRoutes: [
    {
      routeId: '/manager/users/',
      file: 'src/routes/manager/users/index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/manager/users/new/',
      file: 'src/routes/manager/users/new.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/manager/users/$id/',
      file: 'src/routes/manager/users/$id.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/manager/users/$id/update/',
      file: 'src/routes/manager/users/$id.update.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
  ],
  schema: {
    owns: [],
    references: [
      { capability: 'auth', object: 'session' },
      { capability: 'auth', object: 'user' },
    ],
  },
  permissions: {
    resources: [
      {
        resource: 'user',
        actions: [
          'create',
          'list',
          'update',
          'set-role',
          'ban',
          'impersonate',
          'delete',
        ],
      },
    ],
    presetRoleGrants: [
      { role: 'user', resource: 'user', actions: [] },
      {
        role: 'admin',
        resource: 'user',
        actions: [
          'create',
          'list',
          'update',
          'set-role',
          'ban',
          'impersonate',
          'delete',
        ],
      },
    ],
  },
  seeds: [
    {
      id: 'user.local-accounts',
      exportName: 'createLocalUsers',
      purpose: 'core',
      sourceFile: 'drizzle/seed/user.ts',
    },
    {
      id: 'user.demo-directory',
      exportName: 'createDemoUsers',
      purpose: 'demo',
      sourceFile: 'drizzle/seed/user.ts',
    },
  ],
  translations: [
    {
      namespace: 'user',
      files: {
        ar: 'src/app/i18n/ar/user.json',
        en: 'src/app/i18n/en/user.json',
        fr: 'src/app/i18n/fr/user.json',
        sw: 'src/app/i18n/sw/user.json',
      },
    },
  ],
  forms: [
    {
      id: 'user.manager-form',
      gate: '@/modules/user/presentation',
      exportName: 'zFormFieldsUser',
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
    'drizzle/seed/user.ts',
    'src/app/i18n/ar/user.json',
    'src/app/i18n/en/user.json',
    'src/app/i18n/fr/user.json',
    'src/app/i18n/sw/user.json',
    'src/composition/user.ts',
    'src/routes/manager/users/$id.index.tsx',
    'src/routes/manager/users/$id.update.index.tsx',
    'src/routes/manager/users/index.tsx',
    'src/routes/manager/users/new.index.tsx',
    'tsconfig.stryker.user.json',
  ],
});
