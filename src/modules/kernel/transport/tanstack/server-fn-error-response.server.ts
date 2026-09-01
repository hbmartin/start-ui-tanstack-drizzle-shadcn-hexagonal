import {
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server';

import {
  boundedServerFnRetryAfterSeconds,
  type ServerFnError,
} from './server-fn-error';

export const applyServerFnErrorResponse = (error: ServerFnError) => {
  setResponseStatus(error.status);
  if (error.code === 'TOO_MANY_REQUESTS') {
    setResponseHeader(
      'Retry-After',
      String(boundedServerFnRetryAfterSeconds(error.retryAfterSeconds))
    );
  }
};
