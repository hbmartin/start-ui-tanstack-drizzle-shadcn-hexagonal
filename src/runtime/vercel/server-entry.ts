await import('../../../instrument.server.mjs');
const kernel = await import('@/modules/kernel/backend');
kernel.validateServerConfig();
const { initVercelTelemetry } = await import('./telemetry');
initVercelTelemetry();
const { vercelRequestLifecycle } = await import('./request-lifecycle');
const { createApplicationServerEntry } =
  await import('../create-application-server-entry');

export default await createApplicationServerEntry(
  'vercel',
  vercelRequestLifecycle
);
