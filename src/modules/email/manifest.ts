import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const emailCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'email',
  navigation: [],
  preset: 'core',
  removable: false,
  dependsOn: [],
  publicRoutes: [
    {
      routeId: '/api/dev/email/$template',
      file: 'src/routes/api/dev.email.$template.ts',
      kind: 'api',
      access: { kind: 'development-only' },
    },
    {
      routeId: '/api/webhooks/resend',
      file: 'src/routes/api/webhooks.resend.ts',
      kind: 'api',
      access: { kind: 'public' },
    },
  ],
  schema: {
    owns: [
      {
        kind: 'table',
        name: 'email_status',
        gate: '@/modules/email/persistence',
        exportName: 'emailStatus',
      },
    ],
    references: [],
  },
  permissions: { resources: [], presetRoleGrants: [] },
  seeds: [],
  translations: [
    {
      namespace: 'emails',
      files: {
        ar: 'src/app/i18n/ar/emails.json',
        en: 'src/app/i18n/en/emails.json',
        fr: 'src/app/i18n/fr/emails.json',
        sw: 'src/app/i18n/sw/emails.json',
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
    {
      key: 'email-delivery',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'when-enabled',
    },
  ],
  ownedPaths: [
    'src/app/i18n/ar/emails.json',
    'src/app/i18n/en/emails.json',
    'src/app/i18n/fr/emails.json',
    'src/app/i18n/sw/emails.json',
    'src/composition/email-preview.tsx',
    'src/composition/email.ts',
    'src/routes/api/dev.email.$template.ts',
    'src/routes/api/webhooks.resend.ts',
  ],
});
