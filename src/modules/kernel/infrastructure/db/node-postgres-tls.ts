import type { DatabaseTlsPolicy } from '../config/database-tls';

export type NodePostgresSsl = boolean | Readonly<{ rejectUnauthorized: false }>;

/** Exact node-postgres TLS options for the application-owned policy. */
export const nodePostgresSslForPolicy = (
  policy: DatabaseTlsPolicy
): NodePostgresSsl => {
  if (policy === 'off') return false;
  if (policy === 'encrypt') return { rejectUnauthorized: false };
  return true;
};

/**
 * Drizzle Kit accepts either a URL or decomposed credentials, but not a URL
 * plus an independent `ssl` option. Derive a fresh URL from the already
 * validated, override-free source so the CLI receives the same exact policy.
 */
export const nodePostgresConnectionStringForPolicy = (
  connectionString: string,
  policy: DatabaseTlsPolicy
): string => {
  const url = new URL(connectionString);
  if (policy === 'off') {
    url.searchParams.set('sslmode', 'disable');
  } else if (policy === 'encrypt') {
    url.searchParams.set('sslmode', 'require');
    url.searchParams.set('uselibpqcompat', 'true');
  } else {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
};
