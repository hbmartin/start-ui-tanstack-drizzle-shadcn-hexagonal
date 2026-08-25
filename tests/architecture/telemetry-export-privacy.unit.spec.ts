import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const OTEL_CLIENT_PATH = path.resolve(
  process.cwd(),
  'src/composition/telemetry/otel.client.ts'
);
const clientSource = readFileSync(OTEL_CLIENT_PATH, 'utf8');

describe('browser telemetry export privacy', () => {
  it('keeps URL-bearing automatic spans disabled until export projection exists', () => {
    expect(clientSource).not.toMatch(
      /DocumentLoadInstrumentation|FetchInstrumentation|registerInstrumentations/u
    );
  });

  it('does not create raw URL attributes in the browser provider', () => {
    expect(clientSource).not.toMatch(/url\.full|http\.url|location\.href/u);
  });
});
