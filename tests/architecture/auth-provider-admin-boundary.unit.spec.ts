import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const sourceExtensions = new Set(['.ts', '.tsx']);

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) return listSourceFiles(target);
    return sourceExtensions.has(path.extname(target)) ? [target] : [];
  });

const allowedRawProviderMethods = [
  'src/composition/auth.ts:signOut',
  'src/modules/auth/infrastructure/better-auth/session-gateway-better-auth.ts:getSession',
];

type MemberNode = {
  computed?: boolean;
  object?: unknown;
  property?: unknown;
  type?: string;
};

const staticPropertyName = (node: unknown) => {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as { name?: unknown; type?: string; value?: unknown };
  if (candidate.type === 'Identifier' && typeof candidate.name === 'string') {
    return candidate.name;
  }
  if (candidate.type === 'Literal' && typeof candidate.value === 'string') {
    return candidate.value;
  }
  return undefined;
};

const rawProviderApiMembers = (file: string) => {
  const source = readFileSync(file, 'utf8');
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${file}: ${parsed.errors[0]?.message}`);
  }
  const apiAccesses = new Map<string, number>();
  const approvedDirectCalls = new Set<string>();
  const members: string[] = [];
  const range = (node: { end: number; start: number }) =>
    `${node.start}:${node.end}`;
  new Visitor({
    CallExpression(node) {
      const callee = node.callee as MemberNode & { end: number; start: number };
      const object = callee.object as MemberNode & {
        end: number;
        start: number;
      };
      if (
        callee.type === 'MemberExpression' &&
        object?.type === 'MemberExpression' &&
        staticPropertyName(object.property) === 'api'
      ) {
        const method = staticPropertyName(callee.property);
        if (method) {
          approvedDirectCalls.add(range(object));
          members.push(`${path.relative(root, file)}:${method}`);
        }
      }
    },
    MemberExpression(node) {
      if (staticPropertyName(node.property) === 'api') {
        apiAccesses.set(range(node), node.start);
      }
    },
  }).visit(parsed.program);
  for (const [access, start] of apiAccesses) {
    if (approvedDirectCalls.has(access)) continue;
    const line = source.slice(0, start).split('\n').length;
    members.push(`${path.relative(root, file)}:<raw-api-access@${line}>`);
  }
  return members;
};

describe('auth provider administration boundary', () => {
  it('does not install or import the Better Auth admin plugin', () => {
    const violations = listSourceFiles(sourceRoot)
      .filter((file) =>
        /better-auth\/plugins\/admin|better-auth\/plugins['"]/u.test(
          readFileSync(file, 'utf8')
        )
      )
      .map((file) => path.relative(root, file));

    expect(violations).toEqual([]);
  });

  it('confines raw provider API calls to focused auth adapters', () => {
    const calls = listSourceFiles(sourceRoot).flatMap(rawProviderApiMembers);

    expect(calls.toSorted()).toEqual(allowedRawProviderMethods.toSorted());
  });
});
