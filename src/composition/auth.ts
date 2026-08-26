import {
  type AuthEmailPort,
  type AuthHttpGateway,
  type AuthorizationGateway,
  createAuthUseCases,
  type SecondaryStore,
  type SessionGateway,
} from '@/modules/auth';
import {
  type Auth,
  createAuth,
} from '@/modules/auth/infrastructure/better-auth/auth';
import {
  isBlockedBetterAuthHttpRequest,
  TRUSTED_AUTH_CLIENT_IP_HEADER,
  withTrustedAuthClientIp,
} from '@/modules/auth/infrastructure/better-auth/auth-http-exposure';
import { AuthorizationGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/authorization-gateway-better-auth';
import { createAuthHttpRateLimiter } from '@/modules/auth/infrastructure/better-auth/http-rate-limiter';
import { createBetterAuthRateLimitStorage } from '@/modules/auth/infrastructure/better-auth/rate-limit-storage-adapter';
import { SessionGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/session-gateway-better-auth';
import { InMemorySecondaryStore } from '@/modules/auth/infrastructure/secondary-store/in-memory-secondary-store';
import { UpstashSecondaryStore } from '@/modules/auth/infrastructure/secondary-store/upstash-secondary-store';
import { ConfigurationError } from '@/modules/kernel';
import {
  createTelemetryLogger,
  getAuthProviderConfig,
  getBetterAuthConfig,
  getHttpConfig,
  getRedisConfig,
  isProdRuntimeEnvironment,
} from '@/modules/kernel/backend';
import { createTrustedClientIpAdapter } from '@/platform/http/get-client-ip';

import { AuthEmailPortEmailGateway } from './auth-email-port';
import { getEmailGateway } from './email';
import { createCachedFactory } from './shared/singleton';
// Same instance the kernel exposes as `kernel.telemetry`. Sourced from the
// telemetry barrel rather than `getKernel()` to avoid an auth <-> kernel
// composition cycle (kernel dynamically imports this module for permissions).
import { telemetryProxy } from './telemetry';

export type AuthOverrides = {
  sessionGateway?: SessionGateway;
  authorizationGateway?: AuthorizationGateway;
  authEmailPort?: AuthEmailPort;
};

type AuthInstanceOverrides = {
  authEmailPort?: AuthEmailPort;
};

type AuthHttpOverrides = AuthInstanceOverrides & {
  authHttpGateway?: AuthHttpGateway;
  secondaryStore?: SecondaryStore;
};

const buildAuthEmailPort = (overrides?: AuthInstanceOverrides) =>
  overrides?.authEmailPort ??
  new AuthEmailPortEmailGateway(
    getEmailGateway(),
    createTelemetryLogger({ telemetry: telemetryProxy })
  );

/**
 * Durable when Upstash Redis is configured, otherwise a per-process map. The
 * map is fine for single-instance deploys; multi-instance/serverless needs the
 * shared Redis backend (or an edge/WAF control) for cross-instance rate limits.
 */
const buildSecondaryStore = (): SecondaryStore => {
  const redisConfig = getRedisConfig();
  if (redisConfig) {
    return new UpstashSecondaryStore({
      config: redisConfig,
      telemetry: telemetryProxy,
    });
  }
  if (isProdRuntimeEnvironment()) {
    throw new ConfigurationError(
      'Production auth requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for distributed fail-closed rate limiting.'
    );
  }
  return new InMemorySecondaryStore();
};

const secondaryStoreFactory = createCachedFactory<SecondaryStore, never>(
  buildSecondaryStore
);

export const getSecondaryStore = () => secondaryStoreFactory.get();

const assertBetterAuthProvider = () => {
  const { provider } = getAuthProviderConfig();
  if (provider !== 'better-auth') {
    throw new ConfigurationError(
      `AUTH_PROVIDER=${provider} is not implemented in this build.`
    );
  }
};

const buildAuth = (overrides?: AuthInstanceOverrides) => {
  assertBetterAuthProvider();
  return createAuth({
    authEmailPort: buildAuthEmailPort(overrides),
  });
};

const authFactory = createCachedFactory<Auth, AuthInstanceOverrides>(buildAuth);

const getAuth = (overrides?: AuthInstanceOverrides) =>
  authFactory.get(overrides);

export const clearProviderAuthSession = (request: Request) =>
  getAuth().api.signOut({
    asResponse: true,
    headers: request.headers,
  });

const withStandardRetryAfter = (response: Response) => {
  if (response.status !== 429 || response.headers.has('Retry-After')) {
    return response;
  }
  const { otpSendWindowSeconds, rateLimitWindowSeconds } =
    getBetterAuthConfig();
  const maximum = Math.max(otpSendWindowSeconds, rateLimitWindowSeconds);
  const providerValue = response.headers.get('X-Retry-After');
  const parsed =
    providerValue && /^\d+$/u.test(providerValue)
      ? Number(providerValue)
      : maximum;
  const retryAfter = Math.min(maximum, Math.max(1, parsed));
  const headers = new Headers(response.headers);
  headers.set('Retry-After', String(retryAfter));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const buildAuthHttpGateway = (
  overrides?: AuthHttpOverrides
): AuthHttpGateway => {
  if (overrides?.authHttpGateway) return overrides.authHttpGateway;
  const secondaryStore = overrides?.secondaryStore ?? getSecondaryStore();
  const authConfig = getBetterAuthConfig();
  const authInstance = getAuth({
    authEmailPort: overrides?.authEmailPort,
  });
  const rateLimiter = createAuthHttpRateLimiter({
    config: authConfig,
    storage: createBetterAuthRateLimitStorage({
      defaultWindowSeconds: authConfig.rateLimitWindowSeconds,
      hmacSecret: authConfig.rateLimitHmacSecret,
      store: secondaryStore,
    }),
  });

  return {
    handle: async (request, runtimeProfile) => {
      if (await isBlockedBetterAuthHttpRequest(request)) {
        return new Response('Not Found', { status: 404 });
      }
      const trustedRequest = withTrustedAuthClientIp(
        request,
        createTrustedClientIpAdapter({
          runtimeProfile,
          trustedProxyDepth: getHttpConfig().trustedProxyDepth,
        })
      );
      if (
        isProdRuntimeEnvironment() &&
        !trustedRequest.headers.has(TRUSTED_AUTH_CLIENT_IP_HEADER)
      ) {
        return Response.json(
          { error: 'rate_limiter_unavailable' },
          { headers: { 'Retry-After': '60' }, status: 503 }
        );
      }
      const rateLimited = await rateLimiter.check(trustedRequest);
      if (rateLimited) return rateLimited;
      return withStandardRetryAfter(await authInstance.handler(trustedRequest));
    },
  };
};

const authHttpFactory = createCachedFactory<AuthHttpGateway, AuthHttpOverrides>(
  buildAuthHttpGateway
);

export const getAuthHttpGateway = (overrides?: AuthHttpOverrides) =>
  authHttpFactory.get(overrides);

const buildAuthUseCases = (overrides?: AuthOverrides) => {
  const authEmailPort = buildAuthEmailPort(overrides);
  const authInstance = getAuth({ authEmailPort });
  const telemetry = telemetryProxy;

  return createAuthUseCases({
    sessionGateway:
      overrides?.sessionGateway ??
      new SessionGatewayBetterAuth(
        authInstance,
        undefined,
        undefined,
        telemetry
      ),
    authorizationGateway:
      overrides?.authorizationGateway ??
      new AuthorizationGatewayBetterAuth(undefined, telemetry),
    authEmailPort,
  });
};

const factory = createCachedFactory(buildAuthUseCases);

export const getAuthUseCases = (overrides?: AuthOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetAuthComposition = () => {
  factory.reset();
  authFactory.reset();
  authHttpFactory.reset();
  secondaryStoreFactory.reset();
};
