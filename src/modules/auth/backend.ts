import { getAuthHttpGateway, getAuthUseCases } from '@/composition/auth';
import { getKernel } from '@/composition/kernel';
import type { Logger } from '@/modules/kernel';

import { createServerContextTools } from './transport/tanstack/server-context';

export type { AuthenticatedSession, AuthenticatedUser } from './domain/session';
export {
  createServerContextTools,
  type ProcedureLogger,
  type ProtectedContext,
  type PublicContext,
} from './transport/tanstack/server-context';

const kernelLogger: Logger = {
  debug: (fields) => getKernel().logger.debug(fields),
  info: (fields) => getKernel().logger.info(fields),
  warn: (fields) => getKernel().logger.warn(fields),
  error: (fields) => getKernel().logger.error(fields),
};

const serverContextTools = createServerContextTools({
  getAuthUseCases,
  logger: kernelLogger,
  telemetry: getKernel().telemetry,
});

export { getAuthUseCases };
export const handleAuthRequest = (request: Request) =>
  getKernel().telemetry.startSpan(
    {
      attributes: {
        'auth.provider': 'better-auth',
        'http.request.method': request.method,
        'operation.name': 'auth.httpRequest',
        'operation.type': 'http_handler',
      },
      name: 'auth.httpRequest',
      op: 'auth.http',
    },
    () => getAuthHttpGateway().handle(request)
  );
export const assertPermission = serverContextTools.assertPermission;
export const withFreshProtectedMutation =
  serverContextTools.withFreshProtectedMutation;
export const withProtectedContext = serverContextTools.withProtectedContext;
export const withProtectedMutation = serverContextTools.withProtectedMutation;
export const withPublicContext = serverContextTools.withPublicContext;
