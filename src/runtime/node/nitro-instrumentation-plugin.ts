(globalThis as unknown as Record<symbol, unknown>)[
  Symbol.for('start-ui-web.telemetry.node-nitro-fatal-owner')
] = true;
await import('../../../instrument.server.mjs');

// Top-level evaluation is the behavior: Nitro loads plugins while creating the
// app, before its Node preset installs raw fatal-process listeners.
export default () => undefined;
