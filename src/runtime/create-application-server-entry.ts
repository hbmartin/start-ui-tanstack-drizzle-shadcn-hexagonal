import type { ServerEntry } from '@tanstack/react-start/server-entry';

import { isUnexpectedRequestFailure } from '@/platform/http/request-failure';
import type { RuntimeProfile } from '@/platform/runtime/runtime-profile';
import {
  bindRequestExceptionState,
  claimRequestException,
  createRequestExceptionCaptureState,
  reportTelemetryFailure,
} from '@/platform/telemetry';

import type { AppStartRequestContext } from '../start';

type ServerEntryRequestContext = AppStartRequestContext & { nonce?: string };

export type RuntimeRequestLifecycle = {
  onRequestSettled(request: Request): void;
};

export type RuntimeRequestScope = <T>(operation: () => T) => T;

type SynchronousInvocation<T> =
  | { type: 'returned'; value: T }
  | { type: 'threw'; failure: unknown };

const captureSynchronousInvocation = <T>(
  operation: () => T
): SynchronousInvocation<T> => {
  try {
    return { type: 'returned', value: operation() };
  } catch (failure) {
    return { type: 'threw', failure };
  }
};

/**
 * Import-safe universal bootstrap. Instrumentation is evaluated before the
 * telemetry provider and TanStack handler, and the deployment entrypoint
 * injects the trusted profile rather than deriving it from request or host
 * metadata.
 */
export const createApplicationServerEntry = async (
  runtimeProfile: RuntimeProfile,
  lifecycle?: RuntimeRequestLifecycle,
  requestScope?: RuntimeRequestScope
): Promise<ServerEntry> => {
  const { telemetryProxy } = await import('@/platform/telemetry');
  const tanstack = await import('@/entry-server');

  const requestHandler: ServerEntry = {
    async fetch(request) {
      const handleRequest = async () => {
        const telemetryCaptureState = createRequestExceptionCaptureState();
        bindRequestExceptionState(request, telemetryCaptureState);
        const context: ServerEntryRequestContext = {
          requestId: crypto.randomUUID(),
          runtimeProfile,
          telemetryCaptureState,
        };

        try {
          return await tanstack.default.fetch(request, { context });
        } catch (error) {
          if (
            isUnexpectedRequestFailure(error) &&
            claimRequestException(telemetryCaptureState, error)
          ) {
            telemetryProxy.captureException(error, {
              level: 'error',
              tags: {
                event: 'framework.request.failed',
                requestId: context.requestId,
              },
            });
          }
          throw error;
        } finally {
          try {
            lifecycle?.onRequestSettled(request);
          } catch {
            // A lifecycle/export failure must never replace an app response.
          }
        }
      };

      if (!requestScope) return handleRequest();

      let applicationResult: ReturnType<typeof handleRequest> | undefined;
      const runApplicationOnce = () => {
        applicationResult ??= handleRequest();
        return applicationResult;
      };
      const scopeInvocation = captureSynchronousInvocation(() =>
        requestScope(runApplicationOnce)
      );
      if (scopeInvocation.type === 'returned') return scopeInvocation.value;

      reportTelemetryFailure('sentry.request_scope', scopeInvocation.failure);
      return applicationResult ?? runApplicationOnce();
    },
  };

  return tanstack.createServerEntry(requestHandler);
};
