import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  nodePostgresConnectionStringForPolicy,
  nodePostgresSslForPolicy,
} from '@/modules/kernel/infrastructure/db/node-postgres-tls';

const databaseUrl = 'postgres://user@db.example.com:5432/app';

describe('node-postgres database TLS policy', () => {
  it.each([
    ['off', false],
    ['encrypt', { rejectUnauthorized: false }],
    ['verify', true],
  ] as const)('maps %s to exact pg TLS options', (policy, expected) => {
    expect(nodePostgresSslForPolicy(policy)).toEqual(expected);
    const client = new Client({
      connectionString: databaseUrl,
      ssl: nodePostgresSslForPolicy(policy),
    });
    const connectionParameters = (
      client as unknown as {
        connectionParameters: { ssl: boolean | object };
      }
    ).connectionParameters;
    expect(connectionParameters.ssl).toEqual(expected);
  });

  it.each([
    ['off', 'disable', null, false],
    ['encrypt', 'require', 'true', { rejectUnauthorized: false }],
    ['verify', 'verify-full', null, {}],
  ] as const)(
    'derives a Drizzle Kit URL for %s without changing its endpoint',
    (policy, sslmode, libpqCompat, effectiveSsl) => {
      const connectionString = nodePostgresConnectionStringForPolicy(
        databaseUrl,
        policy
      );
      const derived = new URL(connectionString);
      expect(derived.hostname).toBe('db.example.com');
      expect(derived.searchParams.get('sslmode')).toBe(sslmode);
      expect(derived.searchParams.get('uselibpqcompat')).toBe(libpqCompat);
      const client = new Client({ connectionString });
      const connectionParameters = (
        client as unknown as {
          connectionParameters: { ssl: boolean | object };
        }
      ).connectionParameters;
      expect(connectionParameters.ssl).toEqual(effectiveSsl);
    }
  );
});
