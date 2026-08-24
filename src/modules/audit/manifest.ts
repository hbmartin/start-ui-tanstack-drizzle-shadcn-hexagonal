import { defineCapabilityManifest } from '@/modules/kernel/manifest';

export const auditCapabilityManifest = defineCapabilityManifest({
  version: 1,
  id: 'audit',
  navigation: [],
  preset: 'core',
  removable: false,
  dependsOn: [],
  publicRoutes: [],
  schema: {
    owns: [
      {
        kind: 'table',
        name: 'audit_event',
        gate: '@/modules/audit/persistence',
        exportName: 'auditEvent',
      },
    ],
    references: [],
  },
  permissions: { resources: [], presetRoleGrants: [] },
  seeds: [],
  translations: [],
  forms: [],
  backgroundJobs: [],
  runtimeAdapters: [
    {
      key: 'database',
      profiles: ['node', 'vercel', 'cloudflare'],
      required: 'always',
    },
  ],
  ownedPaths: ['src/composition/audit.ts'],
});
