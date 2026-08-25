export type LocalTelemetrySummary = {
  kind: 'frontend_log' | 'otlp_proxy' | 'sentry_tunnel';
  signal?: 'logs' | 'metrics' | 'traces';
  bytes?: number;
  eventCount?: number;
  statusCode?: number;
  summary?: Record<string, unknown>;
};

export type LocalTelemetrySummaryRecorder = (
  input: LocalTelemetrySummary
) => void;

let activeRecorder: LocalTelemetrySummaryRecorder = () => undefined;

export const setLocalTelemetrySummaryRecorder = (
  recorder: LocalTelemetrySummaryRecorder
) => {
  activeRecorder = recorder;
};

export const recordLocalTelemetrySummary: LocalTelemetrySummaryRecorder = (
  input
) => activeRecorder(input);
