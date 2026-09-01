import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSafeCloudflareBuildInput,
  findCloudflareDevVars,
} from '../../../scripts/cloudflare-build-preflight.mjs';

const temporaryDirectories = [];

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-cf-input-'));
  temporaryDirectories.push(root);
  return root;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('Cloudflare production build preflight', () => {
  it('accepts a source tree without local Worker secrets', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, '.env'), 'LOCAL_ONLY=true\n');
    expect(findCloudflareDevVars(root)).toEqual([]);
    expect(() => assertSafeCloudflareBuildInput(root)).not.toThrow();
  });

  it.each(['.dev.vars', '.dev.vars.production'])(
    'fails before build when %s exists',
    (fileName) => {
      const root = fixture();
      fs.writeFileSync(path.join(root, fileName), 'SECRET=sentinel\n');
      expect(() => assertSafeCloudflareBuildInput(root)).toThrow(fileName);
    }
  );
});
