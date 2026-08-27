import { isProdRuntimeEnvironment } from './env-schema';
import type { DatabaseTlsPolicy } from './database-tls';
import { ConfigurationError } from '../../domain/errors/configuration-error';

type RuntimeEnv = Record<string, unknown>;

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const DATABASE_URL_SCHEMES = new Set(['postgres:', 'postgresql:']);

/**
 * node-postgres connection-string parameters that can override the endpoint
 * or the adapter-owned TLS options. Comparisons are case-insensitive so a URL
 * cannot bypass the guard by varying parameter casing.
 */
const FORBIDDEN_DATABASE_URL_PARAMETERS = new Set([
  'host',
  'hostaddr',
  'port',
  'ssl',
  'sslcert',
  'sslkey',
  'sslmode',
  'sslnegotiation',
  'sslrootcert',
  'uselibpqcompat',
]);

const stripIpv6Brackets = (value: string) =>
  value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

function describeDatabaseUrlTlsRemedy({
  policyOverrideName,
  urlOwnerPolicyName,
}: {
  policyOverrideName: string | undefined;
  urlOwnerPolicyName: string | undefined;
}): string {
  if (!urlOwnerPolicyName) {
    return 'configure TLS with the caller-provided policy';
  }
  if (policyOverrideName && urlOwnerPolicyName !== policyOverrideName) {
    return `configure runtime TLS with ${urlOwnerPolicyName} and migration TLS with ${policyOverrideName}`;
  }
  return `configure TLS with ${urlOwnerPolicyName}`;
}

/**
 * True when the URL points at the loopback host. Mirrors the localhost
 * allowance used by the telemetry and storage guards so local development and
 * CI can keep using plain `http://` / `postgres://` connections.
 */
export const isLocalhostUrl = (value: string): boolean => {
  try {
    return LOCALHOST_HOSTNAMES.has(stripIpv6Brackets(new URL(value).hostname));
  } catch {
    return false;
  }
};

/**
 * Rejects cleartext URLs in production. No-op when the value is absent, the
 * runtime is non-production, the host is localhost, or the URL is malformed
 * (malformed URLs are surfaced by the schema's own `url()` validation).
 */
export const assertSecureUrlInProduction = ({
  name,
  value,
  env,
}: {
  name: string;
  value: string | undefined;
  env?: RuntimeEnv;
}): void => {
  if (!value) return;
  if (!isProdRuntimeEnvironment(env)) return;
  if (isLocalhostUrl(value)) return;

  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return;
  }

  if (protocol !== 'https:') {
    throw new ConfigurationError(
      `${name} must use HTTPS in production unless it targets localhost.`
    );
  }
};

/** Reject credentials embedded in a URL before transport errors can log it. */
export const assertUrlHasNoCredentials = ({
  name,
  value,
}: {
  name: string;
  value: string | undefined;
}): void => {
  if (!value) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  if (parsed.username || parsed.password) {
    throw new ConfigurationError(`${name} must not contain URL credentials.`);
  }
};

/**
 * Keeps endpoint and TLS ownership out of the connection string. The database
 * adapter applies `DatabaseTlsPolicy` directly, so URL parameters must not be
 * able to replace that policy or redirect a loopback URL to a remote host.
 */
export const assertDatabaseUrlTls = ({
  name,
  url,
  driver,
  env,
  policy,
  policyOverrideName,
  urlOwnerPolicyName = policyOverrideName,
}: {
  name: string;
  url: string;
  driver: string;
  env?: RuntimeEnv;
  policy: DatabaseTlsPolicy;
  policyOverrideName?: string;
  urlOwnerPolicyName?: string;
}): void => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError(
      `${name} must be an absolute PostgreSQL connection string.`
    );
  }

  if (!DATABASE_URL_SCHEMES.has(parsed.protocol)) {
    throw new ConfigurationError(
      `${name} must use a PostgreSQL connection-string scheme, not ${parsed.protocol}.`
    );
  }

  const forbiddenParameters = [
    ...new Set(
      [...parsed.searchParams.keys()]
        .map((parameterName) => parameterName.toLowerCase())
        .filter(
          (parameterName) =>
            parameterName.startsWith('ssl') ||
            FORBIDDEN_DATABASE_URL_PARAMETERS.has(parameterName)
        )
    ),
  ];
  if (forbiddenParameters.length > 0) {
    const tlsPolicyRemedy = describeDatabaseUrlTlsRemedy({
      policyOverrideName,
      urlOwnerPolicyName,
    });
    throw new ConfigurationError(
      `${name} must not configure endpoint or TLS parameters in the URL (${forbiddenParameters.join(
        ', '
      )}); remove those parameters, keep the endpoint in the URL authority, and ${tlsPolicyRemedy}.`
    );
  }

  if (policy === 'off' && !isLocalhostUrl(url)) {
    throw new ConfigurationError(
      `${name} must not use TLS policy 'off' for a remote database; select a 'verify' policy or target a loopback endpoint.`
    );
  }

  if (
    (driver === 'neon-http' || driver === 'neon-websocket') &&
    policy !== 'verify' &&
    isProdRuntimeEnvironment(env)
  ) {
    const requiredPolicy = policyOverrideName
      ? `${policyOverrideName}=verify`
      : "TLS policy 'verify'";
    throw new ConfigurationError(
      `${name} uses a Neon adapter that owns secure transport; production requires ${requiredPolicy}.`
    );
  }
};
