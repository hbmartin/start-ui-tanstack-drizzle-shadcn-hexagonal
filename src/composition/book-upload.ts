import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import { getAuthUseCases } from '@/composition/auth';
import { getBookUseCases } from '@/composition/book';
import { getKernel } from '@/composition/kernel';
import {
  type BookCoverUploadDeps,
  bookCoverUploadRouteDefinition,
} from '@/modules/book/transport/upload/book-cover';
import { BetterUploadObjectStorage } from '@/modules/kernel/backend';
import { telemetryProxy } from '@/platform/telemetry';

import { createCachedFactory } from './shared/singleton';

const getCurrentSession: BookCoverUploadDeps['getCurrentSession'] = async (
  headers
) => {
  const result = await getAuthUseCases().getCurrentSession({ headers });
  return match(result)
    .with(Result.P.Error(P.select()), (error) => {
      throw error;
    })
    .with(
      Result.P.Ok({ type: 'auth_session_found', session: P.select() }),
      (session) => session
    )
    .with(Result.P.Ok({ type: 'auth_session_missing' }), () => null)
    .exhaustive();
};

const bookUploadRoutes = () => {
  const kernel = getKernel();
  return {
    bookCover: bookCoverUploadRouteDefinition({
      getCurrentSession,
      getUseCases: getBookUseCases,
      telemetry: kernel.telemetry,
      logger: kernel.logger,
    }),
  };
};

const uploadHandlerFactory = createCachedFactory(() => {
  const storage = new BetterUploadObjectStorage();
  return storage.createUploadRequestHandler(bookUploadRoutes());
});

export const handleBookUploadRequest = (request: Request) => {
  return telemetryProxy.startSpan(
    {
      attributes: {
        'http.request.method': request.method,
        'operation.name': 'book.uploadRequest',
        'operation.type': 'http_handler',
        'upload.provider': 'better-upload',
      },
      name: 'book.uploadRequest',
      op: 'upload.http',
    },
    () => uploadHandlerFactory.get()(request)
  );
};
