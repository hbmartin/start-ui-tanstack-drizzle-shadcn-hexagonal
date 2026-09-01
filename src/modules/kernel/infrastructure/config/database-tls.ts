import { isLocalhostUrl } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

export const DATABASE_TLS_POLICIES = ['off', 'encrypt', 'verify'] as const;

export type DatabaseTlsPolicy = (typeof DATABASE_TLS_POLICIES)[number];

export function assertDatabaseTlsPolicy(
  policy: unknown
): asserts policy is DatabaseTlsPolicy {
  if (
    typeof policy === 'string' &&
    DATABASE_TLS_POLICIES.some((candidate) => candidate === policy)
  ) {
    return;
  }
  throw new ConfigurationError(
    "Database TLS policy must be 'off', 'encrypt', or 'verify'."
  );
}

/**
 * Resolve the application-owned database transport policy.
 *
 * Loopback endpoints default to cleartext so PGlite and local PostgreSQL
 * remain usable. Every remote endpoint defaults to certificate and hostname
 * verification, including CLI/tooling processes without NODE_ENV. `off` is
 * loopback-only. `encrypt` is an explicit opt-down that encrypts transport but
 * disables certificate and hostname verification.
 */
export const resolveDatabaseTlsPolicy = ({
  configuredPolicy,
  policyOverrideName,
  policySourceName,
  urlName,
  url,
}: {
  configuredPolicy: DatabaseTlsPolicy | undefined;
  policyOverrideName?: string;
  policySourceName?: string;
  urlName?: string;
  url: string;
}): DatabaseTlsPolicy => {
  if (configuredPolicy !== undefined) {
    assertDatabaseTlsPolicy(configuredPolicy);
  }
  const policy = configuredPolicy ?? (isLocalhostUrl(url) ? 'off' : 'verify');

  if (policy === 'off' && !isLocalhostUrl(url)) {
    if (!policyOverrideName || !policySourceName || !urlName) {
      throw new ConfigurationError(
        "TLS policy 'off' is allowed only for a loopback endpoint; use a 'verify' policy for this remote database."
      );
    }

    throw new ConfigurationError(
      `${urlName} uses ${policySourceName}=off, which is allowed only for a loopback endpoint; set ${policyOverrideName}=verify for this remote database.`
    );
  }

  return policy;
};
