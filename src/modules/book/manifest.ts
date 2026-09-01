import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const bookCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'book',
  navigation: [
    {
      id: 'book.app-primary',
      label: { namespace: 'layout', key: 'nav.books' },
      order: 10,
      routeId: '/app/books/',
      surface: 'app-primary',
    },
    {
      id: 'book.manager-sidebar',
      label: { namespace: 'layout', key: 'nav.books' },
      order: 10,
      routeId: '/manager/books/',
      surface: 'manager-sidebar',
    },
  ],
  preset: 'demo',
  removable: true,
  dependsOn: ['audit', 'auth', 'genre'],
  publicRoutes: [
    {
      routeId: '/app/books/',
      file: 'src/routes/app/books/index.tsx',
      kind: 'page',
      access: { kind: 'authenticated' },
    },
    {
      routeId: '/app/books/$id/',
      file: 'src/routes/app/books/$id.index.tsx',
      kind: 'page',
      access: { kind: 'authenticated' },
    },
    {
      routeId: '/manager/books/',
      file: 'src/routes/manager/books/index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/manager/books/new/',
      file: 'src/routes/manager/books/new.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/manager/books/$id/',
      file: 'src/routes/manager/books/$id.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/manager/books/$id/update/',
      file: 'src/routes/manager/books/$id.update.index.tsx',
      kind: 'page',
      access: { kind: 'permission', resource: 'apps', action: 'manager' },
    },
    {
      routeId: '/api/upload',
      file: 'src/routes/api/upload.ts',
      kind: 'api',
      access: { kind: 'authenticated' },
    },
  ],
  schema: {
    owns: [
      {
        kind: 'table',
        name: 'author',
        gate: '@/modules/book/persistence',
        exportName: 'author',
      },
      {
        kind: 'table',
        name: 'book',
        gate: '@/modules/book/persistence',
        exportName: 'book',
      },
      {
        kind: 'table',
        name: 'publisher',
        gate: '@/modules/book/persistence',
        exportName: 'publisher',
      },
    ],
    references: [{ capability: 'genre', object: 'genre' }],
  },
  permissions: {
    resources: [
      { resource: 'book', actions: ['read', 'create', 'update', 'delete'] },
    ],
    presetRoleGrants: [
      { role: 'user', resource: 'book', actions: ['read'] },
      {
        role: 'admin',
        resource: 'book',
        actions: ['read', 'create', 'update', 'delete'],
      },
    ],
  },
  seeds: [
    {
      id: 'book.demo-catalog',
      exportName: 'createBooks',
      purpose: 'demo',
      sourceFile: 'drizzle/seed/book.ts',
    },
  ],
  translations: [
    {
      namespace: 'book',
      files: {
        ar: 'src/app/i18n/ar/book.json',
        en: 'src/app/i18n/en/book.json',
        fr: 'src/app/i18n/fr/book.json',
        sw: 'src/app/i18n/sw/book.json',
      },
    },
  ],
  forms: [
    {
      id: 'book.editor',
      gate: '@/modules/book/presentation',
      exportName: 'zFormFieldsBook',
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
      key: 'object-storage',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'always',
    },
  ],
  ownedPaths: [
    'drizzle/seed/book-data.json',
    'drizzle/seed/book.ts',
    'src/app/i18n/ar/book.json',
    'src/app/i18n/en/book.json',
    'src/app/i18n/fr/book.json',
    'src/app/i18n/sw/book.json',
    'src/composition/book-upload.ts',
    'src/composition/book.ts',
    'src/routes/api/upload.ts',
    'src/routes/app/books/$id.index.tsx',
    'src/routes/app/books/index.tsx',
    'src/routes/manager/books/$id.index.tsx',
    'src/routes/manager/books/$id.update.index.tsx',
    'src/routes/manager/books/index.tsx',
    'src/routes/manager/books/new.index.tsx',
    'tsconfig.stryker.book.json',
  ],
});
