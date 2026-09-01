import { createFileRoute } from '@tanstack/react-router';

import { isCapabilityRouteEnabled } from '@/app/capabilities/is-capability-route-enabled';
import { handleBookUploadRequest } from '@/composition/book-upload';

export const Route = createFileRoute('/api/upload')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (!isCapabilityRouteEnabled('/api/upload')) {
          return new Response('Not Found', { status: 404 });
        }
        return handleBookUploadRequest(request);
      },
    },
  },
});
