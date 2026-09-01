/**
 * ZoneContextManager requires async/await lowering. Both production client
 * builds and real-browser Vitest transforms must consume this exact target.
 */
export const BROWSER_TELEMETRY_BUILD_TARGET = 'es2015' as const;
