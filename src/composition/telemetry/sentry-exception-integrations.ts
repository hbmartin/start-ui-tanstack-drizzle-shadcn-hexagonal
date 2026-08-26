type NamedIntegration = { name: string };

type ExceptionProcessorApi<TIntegration extends NamedIntegration> = {
  eventFiltersIntegration: () => TIntegration;
  linkedErrorsIntegration: () => TIntegration;
};

/**
 * Build the common exception-only integration set without importing a Sentry
 * runtime. Entrypoints may add explicit exception capture sources between the
 * filter and bounded cause-chain processor.
 */
export const createExceptionOnlyIntegrations = <
  TIntegration extends NamedIntegration,
>(
  api: ExceptionProcessorApi<TIntegration>,
  captureSources: readonly TIntegration[] = []
): TIntegration[] => [
  api.eventFiltersIntegration(),
  ...captureSources,
  api.linkedErrorsIntegration(),
];
