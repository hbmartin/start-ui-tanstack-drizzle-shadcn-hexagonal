import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';

import { describe, expect, it } from 'vitest';

type AstNode = {
  arguments?: AstNode[];
  callee?: AstNode;
  computed?: boolean;
  name?: string;
  object?: AstNode;
  properties?: AstNode[];
  property?: AstNode;
  key?: AstNode;
  type?: string;
  value?: AstNode;
};

const ingressSpecs = [
  {
    callee: 'handleAuthRequest',
    count: 2,
    file: 'src/routes/api/auth.$.ts',
    profileLocation: { argument: 1 } as const,
  },
  {
    callee: 'handleFrontendLogsRequest',
    count: 1,
    file: 'src/routes/api/telemetry.logs.ts',
    profileLocation: { argument: 1 } as const,
  },
  {
    callee: 'handleOtlpProxyRequest',
    count: 1,
    file: 'src/routes/api/telemetry.otel.v1.metrics.ts',
    profileLocation: { argument: 2 } as const,
  },
  {
    callee: 'handleOtlpProxyRequest',
    count: 1,
    file: 'src/routes/api/telemetry.otel.v1.traces.ts',
    profileLocation: { argument: 2 } as const,
  },
  {
    callee: 'handleSentryTunnelRequest',
    count: 1,
    file: 'src/routes/api/telemetry.sentry-tunnel.ts',
    profileLocation: { argument: 1 } as const,
  },
  {
    callee: 'handleResendWebhookRequest',
    count: 1,
    file: 'src/routes/api/webhooks.resend.ts',
    profileLocation: { objectArgument: 1 } as const,
  },
] as const;

const isIdentifier = (node: AstNode | undefined, name: string) =>
  node?.type === 'Identifier' && node.name === name;

const isContextRuntimeProfile = (node: AstNode | undefined) =>
  node?.type === 'MemberExpression' &&
  node.computed === false &&
  isIdentifier(node.object, 'context') &&
  isIdentifier(node.property, 'runtimeProfile');

const objectRuntimeProfile = (node: AstNode | undefined) => {
  if (node?.type !== 'ObjectExpression') return undefined;
  return node.properties?.find(
    (property) =>
      property.type === 'Property' &&
      isIdentifier(property.key, 'runtimeProfile')
  )?.value;
};

const readHandlerCalls = (file: string, callee: string) => {
  const absolutePath = path.resolve(process.cwd(), file);
  const parsed = parseSync(absolutePath, readFileSync(absolutePath, 'utf8'), {
    sourceType: 'module',
  });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse ${file}: ${parsed.errors[0]?.message}`);
  }

  const calls: AstNode[] = [];
  new Visitor({
    CallExpression(node) {
      const call = node as AstNode;
      if (isIdentifier(call.callee, callee)) calls.push(call);
    },
  }).visit(parsed.program);
  return calls;
};

const runtimeProfileArgument = (
  call: AstNode,
  location:
    | Readonly<{ argument: number }>
    | Readonly<{ objectArgument: number }>
) =>
  'argument' in location
    ? call.arguments?.[location.argument]
    : objectRuntimeProfile(call.arguments?.[location.objectArgument]);

describe('runtime-profile HTTP ingress', () => {
  it.each(ingressSpecs)(
    'passes trusted request context through $file',
    ({ callee, count, file, profileLocation }) => {
      const calls = readHandlerCalls(file, callee);
      const profiles = calls.map((call) =>
        runtimeProfileArgument(call, profileLocation)
      );

      expect(calls).toHaveLength(count);
      expect(profiles).toHaveLength(count);
      expect(profiles.every(isContextRuntimeProfile)).toBe(true);
    }
  );
});
