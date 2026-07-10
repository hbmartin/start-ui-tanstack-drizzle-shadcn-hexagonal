import type { QueryClient } from '@tanstack/react-query';

import type { FlagsAdapter } from '@/platform/flags';
import type { TelemetryAdapter } from '@/platform/telemetry';

/**
 * Single typed contract every route loader and `beforeLoad` reads from. The
 * concrete route instance is built once in `src/router.tsx`; root route,
 * server entry, and API/server transport entrypoints are the other wiring
 * surfaces that may cross into composition.
 *
 * Module/feature code MUST read these via `context` rather than importing
 * `@/composition` directly so the composition root remains the only wiring
 * surface.
 */
export type RouterContext = {
  queryClient: QueryClient;
  /** Telemetry/error reporting (Sentry-backed in production). */
  telemetry: TelemetryAdapter;
  /** Feature flag adapter (no-op by default). */
  flags: FlagsAdapter;
};
