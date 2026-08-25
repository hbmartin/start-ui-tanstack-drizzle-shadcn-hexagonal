import { env, tracing } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createCloudflareTelemetryAdapter } from '@/runtime/cloudflare/telemetry-adapter';

type TailRecord = {
  invocationId: string;
  name: null | string;
  parentSpanId: null | string;
  sequence: number;
  spanId: null | string;
  traceId: string;
  type: string;
};

const tailCollector = (
  env as unknown as {
    TELEMETRY_TAIL_COLLECTOR: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  }
).TELEMETRY_TAIL_COLLECTOR;

const readTailRecords = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await tailCollector.fetch('https://telemetry-tail.test/');
    const records = (await response.json()) as TailRecord[];
    const parent = completedSpan(records, 'http.request');
    const child = completedSpan(records, 'db.repository');
    const sibling = findSpan(records, 'auth.http');
    if (parent && child && sibling) {
      return records;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for native Cloudflare span tail events.');
};

const findSpan = (records: TailRecord[], name: string) =>
  records.find(
    (candidate) => candidate.type === 'spanOpen' && candidate.name === name
  );

const completedSpan = (records: TailRecord[], name: string) => {
  const span = findSpan(records, name);
  return span?.spanId &&
    records.some(
      (candidate) =>
        candidate.type === 'spanClose' && candidate.spanId === span.spanId
    )
    ? span
    : undefined;
};

const matchingSpan = (
  records: TailRecord[],
  name: string
): TailRecord & { spanId: string } => {
  const record = findSpan(records, name);
  if (!record?.spanId) throw new Error(`Missing ${name} span-open record.`);
  return { ...record, spanId: record.spanId };
};

const matchingClose = (records: TailRecord[], spanId: string) => {
  const record = records.find(
    (candidate) => candidate.type === 'spanClose' && candidate.spanId === spanId
  );
  if (!record) throw new Error(`Missing close record for span ${spanId}.`);
  return record;
};

describe('Cloudflare telemetry async context', () => {
  it('emits a native child span with the parent context across an await', async () => {
    await tailCollector.fetch('https://telemetry-tail.test/', {
      method: 'DELETE',
    });
    const telemetry = createCloudflareTelemetryAdapter({
      tracing,
    });

    const result = await telemetry.startSpan(
      { name: 'parent', op: 'http.server' },
      async () => {
        await Promise.resolve();
        return telemetry.startSpan(
          { name: 'child', op: 'db.repository' },
          async () => {
            await Promise.resolve();
            return 'nested-result';
          }
        );
      }
    );
    await telemetry.startSpan(
      { name: 'sibling', op: 'auth.http' },
      async () => {
        await Promise.resolve();
      }
    );

    expect(result).toBe('nested-result');

    const records = await readTailRecords();
    const parent = matchingSpan(records, 'http.request');
    const child = matchingSpan(records, 'db.repository');
    const sibling = matchingSpan(records, 'auth.http');
    const childClose = matchingClose(records, child.spanId);
    const parentClose = matchingClose(records, parent.spanId);

    expect(child.invocationId).toBe(parent.invocationId);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.sequence).toBeGreaterThan(parent.sequence);
    expect(childClose.sequence).toBeGreaterThan(child.sequence);
    expect(parentClose.sequence).toBeGreaterThan(childClose.sequence);

    expect(sibling.traceId).toBe(parent.traceId);
    expect(sibling.parentSpanId).toBe(parent.parentSpanId);
    expect(sibling.parentSpanId).not.toBe(parent.spanId);
    expect(sibling.sequence).toBeGreaterThan(parentClose.sequence);
  });
});
