import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const modulesRoot = path.resolve(import.meta.dirname, '../../src/modules');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith('server-functions.ts')
      ? [target]
      : [];
  });

const rawValidatorFiles = () =>
  sourceFiles(modulesRoot)
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      const validatorCount = source.match(/\.validator\(/gu)?.length ?? 0;
      const closedValidatorCount =
        source.match(/\.validator\(serverFnValidator\(/gu)?.length ?? 0;
      return validatorCount !== closedValidatorCount;
    })
    .map((file) => path.relative(modulesRoot, file));

describe('server-function validation boundary', () => {
  it('requires app-owned validation before TanStack can serialize an error', () => {
    expect(rawValidatorFiles()).toEqual([]);
  });
});
