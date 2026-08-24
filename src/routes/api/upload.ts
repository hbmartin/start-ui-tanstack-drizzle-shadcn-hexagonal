import { createFileRoute } from '@tanstack/react-router';

import { handleBookUploadRequest } from '@/composition/book-upload';

export const Route = createFileRoute('/api/upload')({
  server: {
    handlers: {
      POST: ({ request }) => {
        return handleBookUploadRequest(request);
      },
    },
  },
});
