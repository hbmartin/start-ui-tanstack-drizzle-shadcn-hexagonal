import { isProdRuntimeEnvironment } from './env-schema';
import { isLocalhostUrl } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

export const DATABASE_TLS_POLICIES = ['off', 'encrypt', 'verify'] as const;

export type DatabaseTlsPolicy = (typeof DATABASE_TLS_POLICIES)[number];

type RuntimeEnv = Record<string, unknown>;

/**
 * Resolve the application-owned database transport policy.
 *
 * Production defaults to certificate and hostname verification. Local and
 * test runtimes default to cleartext so PGlite and local PostgreSQL remain
 * usable. An explicit production `off` policy is accepted only for a
 * loopback endpoint; this supports local verification of production bundles
 * without permitting a remote cleartext deployment.
 */
export const resolveDatabaseTlsPolicy = ({
  configuredPolicy,
  env,
  url,
}: {
  configuredPolicy: DatabaseTlsPolicy | undefined;
  env?: RuntimeEnv;
  url: string;
}): DatabaseTlsPolicy => {
  const policy =
    configuredPolicy ?? (isProdRuntimeEnvironment(env) ? 'verify' : 'off');

  if (
    policy === 'off' &&
    isProdRuntimeEnvironment(env) &&
    !isLocalhostUrl(url)
  ) {
    throw new ConfigurationError(
      'DATABASE_TLS_POLICY=off is allowed in production only for a loopback database endpoint.'
    );
  }

  return policy;
};
