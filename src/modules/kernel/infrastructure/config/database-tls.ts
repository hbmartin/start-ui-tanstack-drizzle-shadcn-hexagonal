import { isLocalhostUrl } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

export const DATABASE_TLS_POLICIES = ['off', 'encrypt', 'verify'] as const;

export type DatabaseTlsPolicy = (typeof DATABASE_TLS_POLICIES)[number];

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
  policyOverrideName = 'database TLS policy',
  policySourceName = 'database TLS policy',
  urlName = 'database URL',
  url,
}: {
  configuredPolicy: DatabaseTlsPolicy | undefined;
  policyOverrideName?: string;
  policySourceName?: string;
  urlName?: string;
  url: string;
}): DatabaseTlsPolicy => {
  const policy = configuredPolicy ?? (isLocalhostUrl(url) ? 'off' : 'verify');

  if (policy === 'off' && !isLocalhostUrl(url)) {
    throw new ConfigurationError(
      `${urlName} uses ${policySourceName}=off, which is allowed only for a loopback endpoint; set ${policyOverrideName}=verify for this remote database.`
    );
  }

  return policy;
};
