import { context, createContextKey } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';

import { reportTelemetryFailure } from '@/platform/telemetry';

import { claimTelemetryProviderOwnership } from './provider-ownership';

export type SentryNodeRequestContext = {
  contextManager: SentryNodeRequestContextManager;
  release(): void;
};
export type SentryNodeRequestContextManager = InstanceType<
  typeof Sentry.SentryContextManager
>;

const activeManagerProbeKey = createContextKey(
  'start-ui-web.sentry.active-context-manager-probe'
);

export const isSentryNodeRequestContextActive = (
  contextManager: SentryNodeRequestContextManager
) => {
  const marker = Object.freeze({});
  const candidateContext = context
    .active()
    .setValue(activeManagerProbeKey, marker);
  let candidateIsGlobal = false;

  contextManager.with(candidateContext, () => {
    candidateIsGlobal =
      context.active().getValue(activeManagerProbeKey) === marker;
  });

  return candidateIsGlobal;
};

export const createSentryNodeRequestContextManager = ():
  | SentryNodeRequestContextManager
  | undefined => {
  try {
    return new Sentry.SentryContextManager();
  } catch (failure) {
    reportTelemetryFailure('sentry.node.context.create', failure);
    return undefined;
  }
};

export const claimSentryNodeRequestContext = (
  contextManager: SentryNodeRequestContextManager,
  {
    acceptAlreadyInstalledByProvider = false,
  }: { acceptAlreadyInstalledByProvider?: boolean } = {}
): SentryNodeRequestContext | undefined => {
  let enabled = false;
  let acquired = false;
  let acceptedProviderInstall = false;
  try {
    contextManager.enable();
    enabled = true;
    const releaseOwnership = claimTelemetryProviderOwnership([
      {
        acquire: () => {
          acquired = context.setGlobalContextManager(contextManager);
          acceptedProviderInstall =
            !acquired &&
            acceptAlreadyInstalledByProvider &&
            isSentryNodeRequestContextActive(contextManager);
          return acquired || acceptedProviderInstall;
        },
        name: 'context',
        release: () => {
          if (acquired || acceptedProviderInstall) context.disable();
        },
      },
    ]);
    let released = false;

    return {
      contextManager,
      release: () => {
        if (released) return;
        released = true;
        releaseOwnership();
      },
    };
  } catch (failure) {
    if (enabled && !acceptedProviderInstall) {
      contextManager.disable();
    }
    reportTelemetryFailure('sentry.node.context.initialize', failure);
    return undefined;
  }
};

/**
 * Installs the Sentry-aware async context independently of trace exporters.
 * This keeps request isolation available in Sentry-only and degraded OTel
 * configurations without allowing Sentry to install a trace provider.
 */
export const initializeSentryNodeRequestContext = ():
  | SentryNodeRequestContext
  | undefined => {
  const contextManager = createSentryNodeRequestContextManager();
  return contextManager
    ? claimSentryNodeRequestContext(contextManager)
    : undefined;
};

export const runWithSentryNodeRequestIsolation = <T>(operation: () => T): T =>
  Sentry.withIsolationScope(operation);
