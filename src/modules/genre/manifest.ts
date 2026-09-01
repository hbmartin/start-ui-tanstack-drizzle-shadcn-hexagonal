import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const genreCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'genre',
  navigation: [],
  preset: 'demo',
  removable: true,
  dependsOn: ['auth'],
  publicRoutes: [],
  schema: {
    owns: [
      {
        kind: 'table',
        name: 'genre',
        gate: '@/modules/genre/persistence',
        exportName: 'genre',
      },
    ],
    references: [],
  },
  permissions: {
    resources: [{ resource: 'genre', actions: ['read'] }],
    presetRoleGrants: [
      { role: 'user', resource: 'genre', actions: ['read'] },
      { role: 'admin', resource: 'genre', actions: ['read'] },
    ],
  },
  seeds: [
    {
      id: 'genre.demo-catalog',
      sourceFile: 'drizzle/seed/genre.ts',
      exportName: 'createGenres',
      purpose: 'demo',
    },
  ],
  translations: [
    {
      namespace: 'genre',
      files: {
        ar: 'src/app/i18n/ar/genre.json',
        en: 'src/app/i18n/en/genre.json',
        fr: 'src/app/i18n/fr/genre.json',
        sw: 'src/app/i18n/sw/genre.json',
      },
    },
  ],
  forms: [],
  backgroundJobs: [],
  runtimeAdapters: [
    {
      key: 'database',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'always',
    },
  ],
  ownedPaths: [
    'drizzle/seed/genre.ts',
    'src/app/i18n/ar/genre.json',
    'src/app/i18n/en/genre.json',
    'src/app/i18n/fr/genre.json',
    'src/app/i18n/sw/genre.json',
    'src/composition/genre.ts',
    'tsconfig.stryker.genre.json',
  ],
});
