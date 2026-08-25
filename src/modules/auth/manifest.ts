import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const authCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'auth',
  navigation: [],
  preset: 'core',
  removable: false,
  dependsOn: ['email'],
  publicRoutes: [
    {
      routeId: '/api/auth/$',
      file: 'src/routes/api/auth.$.ts',
      kind: 'api',
      access: { kind: 'public' },
    },
    {
      routeId: '/login',
      file: 'src/routes/login/route.tsx',
      kind: 'layout',
      access: { kind: 'public' },
    },
    {
      routeId: '/login/',
      file: 'src/routes/login/index.tsx',
      kind: 'page',
      access: { kind: 'public' },
    },
    {
      routeId: '/login/error/',
      file: 'src/routes/login/error.index.tsx',
      kind: 'page',
      access: { kind: 'public' },
    },
    {
      routeId: '/login/verify/',
      file: 'src/routes/login/verify.index.tsx',
      kind: 'page',
      access: { kind: 'public' },
    },
    {
      routeId: '/onboarding',
      file: 'src/routes/onboarding/route.tsx',
      kind: 'layout',
      access: { kind: 'authenticated' },
    },
    {
      routeId: '/onboarding/',
      file: 'src/routes/onboarding/index.tsx',
      kind: 'page',
      access: { kind: 'authenticated' },
    },
  ],
  schema: {
    owns: [
      {
        kind: 'table',
        name: 'account',
        gate: '@/modules/auth/persistence',
        exportName: 'account',
      },
      {
        kind: 'table',
        name: 'auth_identity',
        gate: '@/modules/auth/persistence',
        exportName: 'authIdentity',
      },
      {
        kind: 'enum',
        name: 'AuthProvider',
        gate: '@/modules/auth/persistence',
        exportName: 'authProviderEnum',
      },
      {
        kind: 'table',
        name: 'session',
        gate: '@/modules/auth/persistence',
        exportName: 'session',
      },
      {
        kind: 'table',
        name: 'user',
        gate: '@/modules/auth/persistence',
        exportName: 'user',
      },
      {
        kind: 'enum',
        name: 'UserRole',
        gate: '@/modules/auth/persistence',
        exportName: 'userRoleEnum',
      },
      {
        kind: 'table',
        name: 'verification',
        gate: '@/modules/auth/persistence',
        exportName: 'verification',
      },
    ],
    references: [],
  },
  permissions: {
    resources: [
      { resource: 'session', actions: ['list', 'revoke'] },
      { resource: 'apps', actions: ['app', 'manager'] },
    ],
    presetRoleGrants: [
      { role: 'user', resource: 'session', actions: [] },
      { role: 'user', resource: 'apps', actions: ['app'] },
      {
        role: 'admin',
        resource: 'session',
        actions: ['list', 'revoke'],
      },
      { role: 'admin', resource: 'apps', actions: ['app', 'manager'] },
    ],
  },
  seeds: [],
  translations: [
    {
      namespace: 'auth',
      files: {
        ar: 'src/app/i18n/ar/auth.json',
        en: 'src/app/i18n/en/auth.json',
        fr: 'src/app/i18n/fr/auth.json',
        sw: 'src/app/i18n/sw/auth.json',
      },
    },
  ],
  forms: [
    {
      id: 'auth.login',
      gate: '@/modules/auth/client',
      exportName: 'zFormFieldsLogin',
    },
    {
      id: 'auth.login-verify',
      gate: '@/modules/auth/client',
      exportName: 'zFormFieldsLoginVerify',
    },
    {
      id: 'auth.onboarding',
      gate: '@/modules/auth/client',
      exportName: 'zFormFieldsOnboarding',
    },
  ],
  backgroundJobs: [],
  runtimeAdapters: [
    {
      key: 'database',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'always',
    },
    {
      key: 'rate-limiting',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'always',
    },
  ],
  ownedPaths: [
    'src/app/i18n/ar/auth.json',
    'src/app/i18n/en/auth.json',
    'src/app/i18n/fr/auth.json',
    'src/app/i18n/sw/auth.json',
    'src/composition/auth-email-port.tsx',
    'src/composition/auth.ts',
    'src/routes/api/auth.$.ts',
    'src/routes/login/error.index.tsx',
    'src/routes/login/index.tsx',
    'src/routes/login/route.tsx',
    'src/routes/login/verify.index.tsx',
    'src/routes/onboarding/index.tsx',
    'src/routes/onboarding/route.tsx',
    'tsconfig.stryker.auth.json',
  ],
});
