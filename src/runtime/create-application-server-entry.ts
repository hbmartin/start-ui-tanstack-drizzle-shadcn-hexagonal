import type { ServerEntry } from '@tanstack/react-start/server-entry';

import type { RuntimeProfile } from '@/platform/runtime/runtime-profile';

import type { AppStartRequestContext } from '../start';

type ServerEntryRequestContext = AppStartRequestContext & { nonce?: string };

/**
 * Import-safe universal bootstrap. Instrumentation is evaluated before the
 * TanStack handler and Sentry wrapper, and the deployment entrypoint injects
 * the trusted profile rather than deriving it from request or host metadata.
 */
export const createApplicationServerEntry = async (
  runtimeProfile: RuntimeProfile
): Promise<ServerEntry> => {
  await import('../../instrument.server.mjs');

  const [sentry, tanstack, kernel] = await Promise.all([
    import('@sentry/tanstackstart-react'),
    import('@tanstack/react-start/server-entry'),
    import('@/modules/kernel/backend'),
  ]);

  kernel.validateServerConfig();

  const requestHandler: ServerEntry = sentry.wrapFetchWithSentry({
    fetch(request) {
      const context: ServerEntryRequestContext = {
        requestId: crypto.randomUUID(),
        runtimeProfile,
      };

      return tanstack.default.fetch(request, { context });
    },
  });

  return tanstack.createServerEntry(requestHandler);
};
