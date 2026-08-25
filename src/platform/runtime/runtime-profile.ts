export const runtimeProfiles = ['node', 'vercel', 'cloudflare'] as const;

export type RuntimeProfile = (typeof runtimeProfiles)[number];

export const databaseAdapterKinds = [
  'postgres-node',
  'postgres-fetch',
  'hyperdrive',
] as const;
export type DatabaseAdapterKind = (typeof databaseAdapterKinds)[number];

export const objectStorageAdapterKinds = [
  'none',
  's3-compatible',
  'r2',
] as const;
export type ObjectStorageAdapterKind =
  (typeof objectStorageAdapterKinds)[number];

export const trustedClientIpAdapterKinds = [
  'trusted-proxy-chain',
  'vercel-forwarded-for',
  'cloudflare-connecting-ip',
] as const;
export type TrustedClientIpAdapterKind =
  (typeof trustedClientIpAdapterKinds)[number];

export const lifecycleAdapterKinds = [
  'persistent-process',
  'vercel-wait-until',
  'cloudflare-execution-context',
] as const;
export type LifecycleAdapterKind = (typeof lifecycleAdapterKinds)[number];

export const rateLimitingAdapterKinds = [
  'upstash',
  'cloudflare-waf-with-upstash',
] as const;
export type RateLimitingAdapterKind = (typeof rateLimitingAdapterKinds)[number];

export const telemetryAdapterKinds = [
  'node-sdk',
  'vercel-otel',
  'cloudflare-otel',
] as const;
export type RuntimeTelemetryAdapterKind =
  (typeof telemetryAdapterKinds)[number];

export type RuntimeCapabilityRequirements = Readonly<{
  database: DatabaseAdapterKind;
  lifecycle: LifecycleAdapterKind;
  objectStorage: ObjectStorageAdapterKind;
  rateLimiting: RateLimitingAdapterKind;
  telemetry: RuntimeTelemetryAdapterKind;
  trustedClientIp: TrustedClientIpAdapterKind;
}>;

export const runtimeCapabilityRequirements = {
  node: {
    database: 'postgres-node',
    lifecycle: 'persistent-process',
    objectStorage: 's3-compatible',
    rateLimiting: 'upstash',
    telemetry: 'node-sdk',
    trustedClientIp: 'trusted-proxy-chain',
  },
  vercel: {
    database: 'postgres-fetch',
    lifecycle: 'vercel-wait-until',
    objectStorage: 's3-compatible',
    rateLimiting: 'upstash',
    telemetry: 'vercel-otel',
    trustedClientIp: 'vercel-forwarded-for',
  },
  cloudflare: {
    database: 'hyperdrive',
    lifecycle: 'cloudflare-execution-context',
    objectStorage: 'r2',
    rateLimiting: 'cloudflare-waf-with-upstash',
    telemetry: 'cloudflare-otel',
    trustedClientIp: 'cloudflare-connecting-ip',
  },
} as const satisfies Readonly<
  Record<RuntimeProfile, RuntimeCapabilityRequirements>
>;

export const isRuntimeProfile = (value: unknown): value is RuntimeProfile =>
  typeof value === 'string' &&
  (runtimeProfiles as readonly string[]).includes(value);

export const parseRuntimeProfile = (value: unknown): RuntimeProfile => {
  if (isRuntimeProfile(value)) return value;
  throw new Error(
    `Runtime profile must be one of: ${runtimeProfiles.join(', ')}.`
  );
};
