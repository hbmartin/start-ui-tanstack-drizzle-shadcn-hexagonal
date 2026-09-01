import { context, createContextKey } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';

import { reportTelemetryFailure } from '@/platform/telemetry';

import { claimTelemetryProviderOwnership } from './provider-ownership';

export type SentryNodeRequestContext = {
  release(): void;
};
export type SentryNodeRequestContextManager = InstanceType<
  typeof Sentry.SentryContextManager
>;

const activeManagerProbeKey = createContextKey(
  'start-ui-web.sentry.active-context-manager-probe'
);
const CONTEXT_PROBE_TIMEOUT_MS = 250;
const contextProbeTimedOut = Symbol('context-probe-timed-out');
const SENTRY_CONTEXT_PROBE_TAG = 'start_ui.context_probe';

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

const runGlobalSentryIsolationProbe = async () => {
  let releaseFirst!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = Sentry.withIsolationScope(async (firstScope) => {
    firstScope.setTag(SENTRY_CONTEXT_PROBE_TAG, 'first');
    await secondStarted;
    return (
      Sentry.getIsolationScope().getScopeData().tags?.[
        SENTRY_CONTEXT_PROBE_TAG
      ] === 'first'
    );
  });
  const second = Sentry.withIsolationScope(async (secondScope) => {
    secondScope.setTag(SENTRY_CONTEXT_PROBE_TAG, 'second');
    releaseFirst();
    await Promise.resolve();
    return (
      Sentry.getIsolationScope().getScopeData().tags?.[
        SENTRY_CONTEXT_PROBE_TAG
      ] === 'second'
    );
  });
  const results = await Promise.all([first, second]);

  return results.every(Boolean);
};

const createContextProbeDeadline = () => {
  let resolveTimeout!: (value: typeof contextProbeTimedOut) => void;
  const elapsed = new Promise<typeof contextProbeTimedOut>((resolve) => {
    resolveTimeout = resolve;
  });
  const timer = setTimeout(
    () => resolveTimeout(contextProbeTimedOut),
    CONTEXT_PROBE_TIMEOUT_MS
  );
  return { cancel: () => clearTimeout(timer), elapsed };
};

const isGlobalRequestContextActive = async () => {
  const deadline = createContextProbeDeadline();
  try {
    const outcome = await Promise.race([
      runGlobalSentryIsolationProbe(),
      deadline.elapsed,
    ]);
    deadline.cancel();
    if (outcome === contextProbeTimedOut) {
      reportTelemetryFailure(
        'sentry.node.context.probe_timeout',
        new Error('Sentry context probe timed out')
      );
      return false;
    }
    return outcome;
  } catch (failure) {
    deadline.cancel();
    reportTelemetryFailure('sentry.node.context.probe', failure);
    return false;
  }
};

const configureSentryNodeAsyncContext = () => {
  try {
    Sentry.setNodeAsyncContextStrategy();
    return true;
  } catch (failure) {
    reportTelemetryFailure('sentry.node.context.strategy', failure);
    return false;
  }
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
  }: {
    acceptAlreadyInstalledByProvider?: boolean;
  } = {}
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
          if (acquired) context.disable();
        },
      },
    ]);
    let released = false;

    return {
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
export const initializeSentryNodeRequestContext = async (): Promise<
  SentryNodeRequestContext | undefined
> => {
  if (!configureSentryNodeAsyncContext()) return undefined;
  if (await isGlobalRequestContextActive()) {
    return { release: () => undefined };
  }

  const contextManager = createSentryNodeRequestContextManager();
  return contextManager
    ? claimSentryNodeRequestContext(contextManager)
    : undefined;
};

export const runWithSentryNodeRequestIsolation = <T>(operation: () => T): T =>
  Sentry.withIsolationScope(operation);
