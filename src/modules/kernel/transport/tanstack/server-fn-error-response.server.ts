import {
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server';

import type { ServerFnError } from './server-fn-error';

export const applyServerFnErrorResponse = (error: ServerFnError) => {
  setResponseStatus(error.status);
  if (error.code === 'TOO_MANY_REQUESTS') {
    setResponseHeader('Retry-After', String(error.retryAfterSeconds));
  }
};
