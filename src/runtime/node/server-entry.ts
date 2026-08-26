await import('../../../instrument.server.mjs');
const kernel = await import('@/modules/kernel/backend');
kernel.validateServerConfig();
const { initNodeTelemetry, runWithNodeSentryRequestIsolation } =
  await import('./telemetry');
await initNodeTelemetry();
const { createApplicationServerEntry } =
  await import('../create-application-server-entry');

export default await createApplicationServerEntry(
  'node',
  undefined,
  runWithNodeSentryRequestIsolation
);
