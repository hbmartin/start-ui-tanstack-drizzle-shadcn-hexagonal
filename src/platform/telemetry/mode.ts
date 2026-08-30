export const telemetryModes = ['off', 'optional', 'required'] as const;
export type TelemetryMode = (typeof telemetryModes)[number];

export const telemetrySignals = [
  'traces',
  'metrics',
  'logs',
  'exceptions',
] as const;
export type TelemetrySignal = (typeof telemetrySignals)[number];
