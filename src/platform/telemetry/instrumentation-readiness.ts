const instrumentationStateKey = Symbol.for(
  'start-ui-web.telemetry.instrumentation-state'
);

type InstrumentationState = Readonly<{
  sentryReady?: boolean;
}>;

export const isServerSentryInstrumentationReady = () => {
  const state = (globalThis as Record<symbol, unknown>)[
    instrumentationStateKey
  ] as InstrumentationState | undefined;
  return state?.sentryReady === true;
};
