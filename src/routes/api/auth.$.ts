import { createFileRoute } from '@tanstack/react-router';

import { handleAuthRequest } from '@/modules/auth/backend';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request, context }) => {
        return handleAuthRequest(request, context.runtimeProfile);
      },
      POST: ({ request, context }) => {
        return handleAuthRequest(request, context.runtimeProfile);
      },
    },
  },
});
