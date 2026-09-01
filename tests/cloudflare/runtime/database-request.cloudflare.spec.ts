import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import {
  createHyperdriveDbClient,
  getDefaultDbClient,
  runWithRuntimeDatabaseClient,
} from '@/modules/kernel/backend';
import { bindCloudflareDatabaseToResponse } from '@/runtime/cloudflare/database-request';

type TestCloudflareEnvironment = {
  START_UI_DATABASE?: { connectionString: string };
};

const within = <T>(operation: Promise<T>, label: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      2_000
    );
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
        return undefined;
      },
      (failure: unknown) => {
        clearTimeout(timeout);
        reject(failure);
        return undefined;
      }
    );
  });

describe('Cloudflare Hyperdrive request lifecycle', () => {
  it('queries through the injected binding during delayed stream production', async () => {
    const binding = (env as unknown as TestCloudflareEnvironment)
      .START_UI_DATABASE;
    expect(binding?.connectionString).toMatch(/^postgresql?:\/\//u);
    const database = await within(
      createHyperdriveDbClient(binding),
      'Hyperdrive connection'
    );
    const close = vi.spyOn(database, '$close');
    const cachedDatabase = getDefaultDbClient();
    const request = new Request('https://app.example.test/database-stream');

    const response = await runWithRuntimeDatabaseClient(database, async () =>
      bindCloudflareDatabaseToResponse({
        database,
        request,
        response: new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Promise.resolve();
              const result = await cachedDatabase.$client.query<{
                value: number;
              }>('SELECT 1::int AS value');
              controller.enqueue(
                new TextEncoder().encode(String(result.rows[0]?.value))
              );
              controller.close();
            },
          }),
          {
            headers: { 'x-database-adapter': 'hyperdrive' },
            status: 206,
            statusText: 'Partial Content',
          }
        ),
      })
    );

    expect(response.status).toBe(206);
    expect(response.statusText).toBe('Partial Content');
    expect(response.headers.get('x-database-adapter')).toBe('hyperdrive');
    expect(close).not.toHaveBeenCalled();
    await expect(within(response.text(), 'Hyperdrive stream')).resolves.toBe(
      '1'
    );
    await within(
      vi.waitFor(() => expect(close).toHaveBeenCalledOnce()),
      'Hyperdrive release'
    );
    expect(() => cachedDatabase.$adapter).toThrow(
      /request-scoped runtime database is unavailable/u
    );
  });
});
