import type { TelemetryLogLevel } from './types';

const CONSOLE_METHOD_BY_LOG_LEVEL = {
  debug: 'debug',
  error: 'error',
  info: 'info',
  warn: 'warn',
} as const satisfies Record<
  TelemetryLogLevel,
  keyof Pick<Console, TelemetryLogLevel>
>;

export const writeStructuredConsoleLog = ({
  level,
  message,
  record,
}: {
  level: TelemetryLogLevel;
  message: string;
  record: Record<string, unknown>;
}) => {
  const consoleLike = globalThis.console;
  const method = consoleLike?.[CONSOLE_METHOD_BY_LOG_LEVEL[level]];
  if (typeof method !== 'function') return;

  method.call(consoleLike, message, { level, ...record });
};
