import { beforeEach, describe, expect, it } from 'vitest';

import collector from '../../../cloudflare/support/telemetry-tail-collector.mjs';

const onset = (sequence) => ({
  event: { name: 'bounded.record', type: 'spanOpen' },
  invocationId: 'bounded-invocation',
  sequence,
  spanContext: {
    spanId: sequence.toString(16).padStart(16, '0'),
    traceId: sequence.toString(16).padStart(32, '0'),
  },
});

beforeEach(async () => {
  await collector.fetch(
    new Request('https://telemetry-tail.test/', { method: 'DELETE' })
  );
});

describe('Cloudflare telemetry tail collector', () => {
  it('retains only the newest 5,000 projected records', async () => {
    for (let sequence = 0; sequence < 5_001; sequence += 1) {
      collector.tailStream(onset(sequence));
    }

    const response = await collector.fetch(
      new Request('https://telemetry-tail.test/')
    );
    const records = await response.json();

    expect(records).toHaveLength(5_000);
    expect(records[0]?.sequence).toBe(1);
    expect(records.at(-1)?.sequence).toBe(5_000);
    expect(records).not.toContainEqual(
      expect.objectContaining({ sequence: 0 })
    );
  });
});
