import { createServerFn } from '@tanstack/react-start';

import { telemetryProxy } from '@/platform/telemetry';

export {
  isOpaquePublicCorrelationId,
  isPublicServerErrorDto,
  isServerFnError,
  PUBLIC_SERVER_ERROR_REASONS,
  PUBLIC_SERVER_ERROR_TARGETS,
  SERVER_FN_ERROR_CODES,
  ServerFnError,
  serverFnErrorSerializationAdapter,
  type PublicServerErrorDto,
  type PublicServerErrorReason,
  type PublicServerErrorTarget,
  type ServerFnErrorCode,
} from './transport/tanstack/server-fn-error';
export { serverFnValidator } from './transport/tanstack/server-fn-validator';

export const initSsrApp = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { createSsrAppHandlers } =
      await import('./transport/tanstack/ssr-app-init');

    return telemetryProxy.startSpan(
      {
        attributes: {
          'operation.name': 'kernel.initSsrApp',
          'operation.type': 'server_function',
        },
        name: 'kernel.initSsrApp',
        op: 'server.function',
      },
      () => createSsrAppHandlers().init()
    );
  }
);
