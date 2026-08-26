import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSync, Visitor } from 'oxc-parser';

const profileNames = ['node', 'vercel', 'cloudflare'];
const profiles = new Set(profileNames);
const forbiddenRuntimeTokens = {
  cloudflare: [
    '@sentry/node',
    '@vercel/functions',
    '@vercel/otel',
    'AsyncLocalStorageContextManager',
    'NodeTracerProvider',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/sdk-trace-node',
    'telemetry_summary',
  ],
  node: [
    '@sentry/cloudflare',
    '@vercel/functions',
    '@vercel/otel',
    'cloudflare:workers',
    'START_UI_TELEMETRY_METRICS',
  ],
  vercel: [
    '@sentry/cloudflare',
    'cloudflare:workers',
    'initOpenTelemetryServer',
    'otel.node.initialize',
    'otel.server.shutdown',
    'START_UI_TELEMETRY_METRICS',
    'telemetry_summary',
  ],
};
const requiredRuntimeTokens = {
  cloudflare: ['cloudflare:workers', 'START_UI_TELEMETRY_METRICS'],
  node: ['NodeTracerProvider'],
  vercel: ['@vercel/functions', '@vercel/otel'],
};
const requiredServerEntryOwner = {
  node: 'runWithNodeSentryRequestIsolation',
  vercel: 'runWithVercelSentryRequestIsolation',
};

const fail = (message) => {
  throw new Error(`Runtime profile verification failed: ${message}`);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const assertFile = (filePath) =>
  assert(fs.statSync(filePath, { throwIfNoEntry: false })?.isFile(), filePath);

const assertDirectory = (directoryPath) =>
  assert(
    fs.statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory(),
    directoryPath
  );

const hasCompatibilityFlag = (config, flag) =>
  Array.isArray(config.compatibility_flags) &&
  config.compatibility_flags.includes(flag);

const isCompatibilityDate = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);

const readJson = (filePath) => {
  assertFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const readParsedModule = (filePath) => {
  assertFile(filePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const parsed = parseSync(filePath, source, { sourceType: 'module' });
  assert(
    parsed.errors.length === 0,
    `${filePath} must be parseable before checking server entry ownership`
  );
  return { program: parsed.program, source };
};

const readApplicationServerEntryCalls = (filePath) => {
  const { program } = readParsedModule(filePath);
  const calls = [];
  new Visitor({
    CallExpression(node) {
      if (
        node.callee?.type === 'Identifier' &&
        node.callee.name === 'createApplicationServerEntry'
      ) {
        calls.push(node);
      }
    },
  }).visit(program);
  return calls;
};

const assertOnlyProfileMarker = (filePath, expectedProfile) => {
  const calls = readApplicationServerEntryCalls(filePath);
  assert(
    calls.length === 1 &&
      calls[0].arguments?.[0]?.type === 'Literal' &&
      calls[0].arguments[0].value === expectedProfile,
    `${filePath} must contain exactly one ${expectedProfile} profile marker`
  );
};

const identifierName = (node) =>
  node?.type === 'Identifier' ? node.name : undefined;

const assertServerEntryOwners = (filePath, profile) => {
  const [entryCall] = readApplicationServerEntryCalls(filePath);
  const expectedOwner = requiredServerEntryOwner[profile];
  const actualOwner = identifierName(entryCall.arguments[2]);
  assert(
    actualOwner === expectedOwner,
    `${filePath} must contain ${profile} server entry owner ${expectedOwner}`
  );
};

const propertyLocalName = (property) => identifierName(property?.value);

const literalString = (node) => {
  if (node?.type !== 'Literal') return undefined;
  return typeof node.value === 'string' ? node.value : undefined;
};

const unwrapAwaitExpression = (node) =>
  node?.type === 'AwaitExpression' ? node.argument : node;

const dynamicImportSource = (declarator) => {
  const importExpression = unwrapAwaitExpression(declarator.init);
  if (importExpression?.type !== 'ImportExpression') return undefined;
  return literalString(importExpression.source);
};

const findTopLevelDynamicImport = (program, localName) => {
  const matches = program.body.flatMap((statement) =>
    statement.type === 'VariableDeclaration'
      ? statement.declarations.filter(
          (declarator) =>
            declarator.id?.type === 'ObjectPattern' &&
            declarator.id.properties.some(
              (property) => propertyLocalName(property) === localName
            ) &&
            dynamicImportSource(declarator)
        )
      : []
  );
  return matches.length === 1 ? dynamicImportSource(matches[0]) : undefined;
};

const topLevelAwaitedExpression = (statement) => {
  if (statement.type !== 'ExpressionStatement') return undefined;
  if (statement.expression.type !== 'AwaitExpression') return undefined;
  return statement.expression.argument;
};

const isAwaitedTopLevelCall = (statement, localName) => {
  const call = topLevelAwaitedExpression(statement);
  if (call?.type !== 'CallExpression') return false;
  return identifierName(call.callee) === localName;
};

const isWithinDirectory = (filePath, directoryPath) => {
  const relativePath = path.relative(directoryPath, filePath);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
};

const resolveLinkedModule = (fromFile, specifier, artifactRoot) => {
  assert(
    specifier.startsWith('.'),
    `${fromFile} must import Node telemetry from its artifact`
  );
  const linkedFile = path.resolve(path.dirname(fromFile), specifier);
  assert(
    isWithinDirectory(linkedFile, artifactRoot),
    `${fromFile} must keep Node telemetry inside its artifact`
  );
  assertFile(linkedFile);
  return linkedFile;
};

const staticImportForBinding = (statement, localName) => {
  if (statement.type !== 'ImportDeclaration') return undefined;
  const specifier = statement.specifiers.find(
    (candidate) => identifierName(candidate.local) === localName
  );
  if (specifier?.type !== 'ImportSpecifier') return undefined;
  return {
    importedName: identifierName(specifier.imported),
    source: literalString(statement.source),
  };
};

const findStaticImport = (program, localName) =>
  program.body
    .map((statement) => staticImportForBinding(statement, localName))
    .find(Boolean);

const isFunctionExpression = (node) =>
  node?.type === 'ArrowFunctionExpression' ||
  node?.type === 'FunctionExpression';

const variableFunctionEntry = (declarator) => {
  if (declarator.id.type !== 'Identifier') return [];
  return isFunctionExpression(declarator.init)
    ? [[declarator.id.name, declarator.init]]
    : [];
};

const topLevelFunctionEntries = (statement) => {
  if (statement.type === 'VariableDeclaration') {
    return statement.declarations.flatMap(variableFunctionEntry);
  }
  if (statement.type !== 'FunctionDeclaration') return [];
  return statement.id ? [[statement.id.name, statement]] : [];
};

const namedExportEntry = (specifier) => {
  const exportedName = identifierName(specifier.exported);
  const localName = identifierName(specifier.local);
  return exportedName && localName ? [[exportedName, localName]] : [];
};

const namedExportEntries = (statement) =>
  statement.type === 'ExportNamedDeclaration'
    ? statement.specifiers.flatMap(namedExportEntry)
    : [];

const nestedFunctionRanges = (functionNode) => {
  const ranges = [];
  const recordNestedRange = (node) => {
    if (node !== functionNode) ranges.push([node.start, node.end]);
  };
  new Visitor({
    ArrowFunctionExpression: recordNestedRange,
    FunctionDeclaration: recordNestedRange,
    FunctionExpression: recordNestedRange,
  }).visit(functionNode);
  return ranges;
};

const isInsideNestedFunction = (node, ranges) =>
  ranges.some(([start, end]) => start <= node.start && node.end <= end);

const directFunctionCalls = (functionNode, nestedRanges) => {
  const calls = new Set();
  new Visitor({
    CallExpression(node) {
      if (isInsideNestedFunction(node, nestedRanges)) return;
      const name = identifierName(node.callee);
      if (name) calls.add(name);
    },
  }).visit(functionNode);
  return calls;
};

const constructedIdentifierName = (node) => {
  const directName = identifierName(node.callee);
  return directName || identifierName(node.callee.property);
};

const directlyConstructsSentryContext = (functionNode, nestedRanges) => {
  let constructsSentryContext = false;
  new Visitor({
    NewExpression(node) {
      if (isInsideNestedFunction(node, nestedRanges)) return;
      if (constructedIdentifierName(node) === 'SentryContextManager') {
        constructsSentryContext = true;
      }
    },
  }).visit(functionNode);
  return constructsSentryContext;
};

const inspectFunction = (functionNode) => {
  const nestedRanges = nestedFunctionRanges(functionNode);
  return {
    calls: directFunctionCalls(functionNode, nestedRanges),
    constructsSentryContext: directlyConstructsSentryContext(
      functionNode,
      nestedRanges
    ),
  };
};

const reachableFunctions = (functions, initialName) => {
  const pending = [initialName];
  const visited = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    const functionNode = functions.get(name);
    if (!functionNode) continue;
    visited.add(name);
    const { calls } = inspectFunction(functionNode);
    pending.push(...calls.values().filter((call) => functions.has(call)));
  }
  return visited;
};

const ownsNodeAsyncContext = (program, exportedBinding) => {
  const functions = new Map(program.body.flatMap(topLevelFunctionEntries));
  const exports = new Map(program.body.flatMap(namedExportEntries));
  const initialName = exports.get(exportedBinding) ?? exportedBinding;
  const evidence = [...reachableFunctions(functions, initialName)].map((name) =>
    inspectFunction(functions.get(name))
  );
  return (
    evidence.some(({ calls }) =>
      calls.has('initializeSentryNodeRequestContext')
    ) && evidence.some(({ constructsSentryContext }) => constructsSentryContext)
  );
};

const localBindingForExport = (program, exportedBinding) => {
  const exports = new Map(program.body.flatMap(namedExportEntries));
  return exports.get(exportedBinding) ?? exportedBinding;
};

const nextTelemetryLink = (program, currentBinding) => {
  const localBinding = localBindingForExport(program, currentBinding);
  const linkedImport = findStaticImport(program, localBinding);
  if (!linkedImport) return undefined;
  if (!linkedImport.importedName) return undefined;
  if (!linkedImport.source) return undefined;
  return {
    binding: linkedImport.importedName,
    source: linkedImport.source,
  };
};

const findLinkedNodeAsyncContextOwner = (
  initialFile,
  artifactRoot,
  initialBinding
) => {
  let currentFile = initialFile;
  let currentBinding = initialBinding;
  for (let depth = 0; depth < 5; depth += 1) {
    const { program } = readParsedModule(currentFile);
    if (ownsNodeAsyncContext(program, currentBinding)) return true;
    const nextLink = nextTelemetryLink(program, currentBinding);
    if (!nextLink) return false;
    currentFile = resolveLinkedModule(
      currentFile,
      nextLink.source,
      artifactRoot
    );
    currentBinding = nextLink.binding;
  }
  return false;
};

const assertNodeAsyncContextOwner = (entryFile, artifactRoot) => {
  const { program: entryProgram } = readParsedModule(entryFile);
  const entryImport = findTopLevelDynamicImport(
    entryProgram,
    'initNodeTelemetry'
  );
  assert(
    entryImport,
    `${entryFile} must import its Node telemetry initializer`
  );
  assert(
    entryProgram.body.some((statement) =>
      isAwaitedTopLevelCall(statement, 'initNodeTelemetry')
    ),
    `${entryFile} must await its imported Node telemetry initializer`
  );

  const initialFile = resolveLinkedModule(entryFile, entryImport, artifactRoot);
  assert(
    findLinkedNodeAsyncContextOwner(
      initialFile,
      artifactRoot,
      'initNodeTelemetry'
    ),
    `${entryFile} must link its Node async-context owner`
  );
};

const findFilesNamedLike = (directoryPath, predicate) => {
  return fs
    .readdirSync(directoryPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

const assertNoForbiddenRuntimeTokens = (directoryPath, profile) => {
  const files = findFilesNamedLike(directoryPath, (name) =>
    /\.(?:cjs|js|json|mjs)$/u.test(name)
  );
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const token of forbiddenRuntimeTokens[profile]) {
      assert(
        !source.includes(token),
        `${filePath} contains forbidden ${profile} runtime token ${token}`
      );
    }
  }
};

const assertRequiredRuntimeTokens = (directoryPath, profile) => {
  const sources = findFilesNamedLike(directoryPath, (name) =>
    /\.(?:cjs|js|json|mjs)$/u.test(name)
  ).map((filePath) => fs.readFileSync(filePath, 'utf8'));
  for (const token of requiredRuntimeTokens[profile]) {
    assert(
      sources.some((source) => source.includes(token)),
      `${directoryPath} must contain ${profile} runtime owner ${token}`
    );
  }
};

const verifyNode = (root) => {
  const output = path.join(root, '.output/node');
  const manifest = readJson(path.join(output, 'nitro.json'));
  assert(manifest.preset === 'node-server', 'Node Nitro preset');
  assert(manifest.serverEntry === 'server/index.mjs', 'Node server entry');
  assert(manifest.publicDir === 'public', 'Node public directory');
  assertFile(path.join(output, manifest.serverEntry));
  assertDirectory(path.join(output, manifest.publicDir));
  const applicationEntry = path.join(output, 'server/_ssr/ssr.mjs');
  assertOnlyProfileMarker(applicationEntry, 'node');
  assertServerEntryOwners(applicationEntry, 'node');
  assertNodeAsyncContextOwner(applicationEntry, path.join(output, 'server'));
  assertRequiredRuntimeTokens(path.join(output, 'server'), 'node');
  assertNoForbiddenRuntimeTokens(path.join(output, 'server'), 'node');
};

const verifyVercel = (root) => {
  const output = path.join(root, '.vercel/output');
  const manifest = readJson(path.join(output, 'nitro.json'));
  const buildOutput = readJson(path.join(output, 'config.json'));
  const functionConfig = readJson(
    path.join(output, 'functions/__server.func/.vc-config.json')
  );
  assert(manifest.preset === 'vercel', 'Vercel Nitro preset');
  assert(
    manifest.serverEntry === 'functions/__server.func/index.mjs',
    'Vercel server entry'
  );
  assert(buildOutput.version === 3, 'Vercel Build Output API v3');
  assert(functionConfig.runtime === 'nodejs24.x', 'Vercel Node 24 runtime');
  assert(functionConfig.supportsResponseStreaming, 'Vercel response streaming');
  assertFile(path.join(output, manifest.serverEntry));
  assertDirectory(path.join(output, manifest.publicDir));
  const applicationEntry = path.join(
    output,
    'functions/__server.func/_ssr/ssr.mjs'
  );
  assertOnlyProfileMarker(applicationEntry, 'vercel');
  assertServerEntryOwners(applicationEntry, 'vercel');
  assertRequiredRuntimeTokens(
    path.join(output, 'functions/__server.func'),
    'vercel'
  );
  assertNoForbiddenRuntimeTokens(
    path.join(output, 'functions/__server.func'),
    'vercel'
  );
};

const verifyCloudflare = (root, expectedAppSlug) => {
  const output = path.join(root, 'dist');
  const sourceConfig = readJson(path.join(root, 'wrangler.json'));
  const generatedConfig = readJson(path.join(output, 'server/wrangler.json'));
  assert(sourceConfig.main === 'src/server.ts', 'Cloudflare source entry');
  assert(
    hasCompatibilityFlag(sourceConfig, 'nodejs_compat'),
    'Cloudflare Sentry AsyncLocalStorage compatibility'
  );
  assert(
    typeof expectedAppSlug === 'string' && expectedAppSlug.length > 0,
    'APP_SLUG must be supplied for Cloudflare artifact verification'
  );
  assert(sourceConfig.name === expectedAppSlug, 'Cloudflare APP_SLUG identity');
  assert(generatedConfig.main === 'index.js', 'Cloudflare Worker entry');
  assert(
    generatedConfig.name === sourceConfig.name,
    'Cloudflare generated Worker name'
  );
  assert(
    isCompatibilityDate(sourceConfig.compatibility_date),
    'Cloudflare source compatibility date format'
  );
  assert(
    isCompatibilityDate(generatedConfig.compatibility_date),
    'Cloudflare generated compatibility date format'
  );
  assert(
    generatedConfig.compatibility_date === sourceConfig.compatibility_date,
    'Cloudflare generated compatibility date drift'
  );
  assert(
    hasCompatibilityFlag(generatedConfig, 'nodejs_compat'),
    'Cloudflare generated AsyncLocalStorage compatibility'
  );
  assert(
    generatedConfig.assets?.directory === '../client',
    'Cloudflare client asset binding'
  );
  assert(
    findFilesNamedLike(
      output,
      (name) => name === '.dev.vars' || name.startsWith('.dev.vars.')
    ).length === 0,
    'Cloudflare production output must not contain .dev.vars files'
  );
  assertDirectory(path.join(output, 'client'));
  assertOnlyProfileMarker(path.join(output, 'server/index.js'), 'cloudflare');
  assertRequiredRuntimeTokens(path.join(output, 'server'), 'cloudflare');
  assertNoForbiddenRuntimeTokens(path.join(output, 'server'), 'cloudflare');
};

export const verifyRuntimeProfile = (
  profile,
  root = process.cwd(),
  { expectedAppSlug = process.env.APP_SLUG } = {}
) => {
  assert(profiles.has(profile), `unknown profile ${String(profile)}`);
  if (profile === 'node') verifyNode(root);
  else if (profile === 'vercel') verifyVercel(root);
  else verifyCloudflare(root, expectedAppSlug);
  return profile;
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    const profile = verifyRuntimeProfile(process.argv[2]);
    console.log(`Verified ${profile} runtime artifact contract.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
