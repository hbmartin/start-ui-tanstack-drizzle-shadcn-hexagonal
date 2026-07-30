import { createFileRoute } from '@tanstack/react-router';

import { getKernel } from '@/composition/kernel';
import { handleOutboxDrainRequest } from '@/modules/lifecycle-events/backend';

/**
 * Host-agnostic outbox drain trigger: point a platform cron (Vercel/Railway/
 * Render/GitHub Actions) at `POST /api/tasks/outbox/drain` with
 * `Authorization: Bearer $OUTBOX_DRAIN_SECRET`. Concurrent triggers are safe —
 * the drain claims rows with `FOR UPDATE SKIP LOCKED`.
 */
export const Route = createFileRoute('/api/tasks/outbox/drain')({
  server: {
    handlers: {
      POST: ({ request }) => {
        return handleOutboxDrainRequest(request, {
          logger: getKernel().logger,
        });
      },
    },
  },
});
