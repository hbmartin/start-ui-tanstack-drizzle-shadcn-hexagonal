import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync, Visitor as ProgramVisitor, visitorKeys } from 'oxc-parser';

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
  cloudflare: [
    'cloudflare:workers',
    'START_UI_DATABASE',
    'START_UI_TELEMETRY_METRICS',
  ],
  node: ['NodeTracerProvider'],
  vercel: ['@vercel/functions', '@vercel/otel'],
};
const requiredServerEntryOwner = {
  node: 'runWithNodeSentryRequestIsolation',
  vercel: 'runWithVercelSentryRequestIsolation',
};
const cloudflareAppChunkProvenanceFile = 'start-ui-app-chunk-provenance.json';
const cloudflareAppChunkProvenanceKeyEnvironment =
  'START_UI_CLOUDFLARE_PROVENANCE_KEY';
let activeCloudflareAppChunkProvenanceKey;

const fail = (message) => {
  throw new Error(`Runtime profile verification failed: ${message}`);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const assertConditions = (conditions, message) =>
  assert(conditions.every(Boolean), message);

const nodeType = (node) => node?.type;

const compareCodePointStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const astVisitorChildren = (node) =>
  (visitorKeys[nodeType(node)] ?? []).flatMap((key) => {
    const value = node[key];
    return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
  });

const runtimeArtifactTraversalWorkLimit = 1_000_000;
const runtimeArtifactTraversalWorkMessage =
  'runtime artifact analysis exceeded bounded AST traversal work';

const visitAstSubtree = (root, visitor) => {
  const pending = [root];
  const preserveSourceOrder = nodeType(root) === 'Program';
  let work = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    work += 1;
    assert(
      work <= runtimeArtifactTraversalWorkLimit,
      runtimeArtifactTraversalWorkMessage
    );
    const handler = visitor[nodeType(node)];
    if (typeof handler === 'function') handler(node);
    const children = astVisitorChildren(node);
    assert(
      work + pending.length + children.length <=
        runtimeArtifactTraversalWorkLimit,
      runtimeArtifactTraversalWorkMessage
    );
    if (preserveSourceOrder) {
      children.toReversed().forEach((child) => pending.push(child));
    } else {
      children.forEach((child) => pending.push(child));
    }
  }
};

export const inspectAstTraversalForTesting = (source) => {
  const program = parseModuleSource('ast-traversal.fixture.js', source).program;
  new Visitor({}).visit(program);
  return true;
};

class Visitor extends ProgramVisitor {
  constructor(visitor) {
    super(visitor);
    this.visitor = visitor;
  }

  visit(node) {
    visitAstSubtree(node, this.visitor);
  }
}

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

const viteManifestEntries = (manifest, manifestFile) => {
  assert(
    manifest !== null &&
      typeof manifest === 'object' &&
      !Array.isArray(manifest),
    `${manifestFile} must contain a Vite manifest object`
  );
  const entries = Object.values(manifest);
  assert(
    entries.every(
      (entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ),
    `${manifestFile} must contain valid Vite manifest entries`
  );
  return entries;
};

const parsedModuleCache = new Map();
const parsedModuleSourceCache = new Map();
const authenticatedCloudflareModuleSources = new Map();
const verifiedCloudflareMetadataSources = new Map();
const maximumCachedParsedModuleBytes = 65_536;
const runtimeProfileVerifierFile = fileURLToPath(import.meta.url);
const clearParsedModuleCaches = () => {
  parsedModuleCache.clear();
  parsedModuleSourceCache.clear();
};

const readVerifiedCloudflareMetadataJson = (filePath) => {
  const realFile = fs.realpathSync(filePath);
  const metadata = fs.lstatSync(filePath);
  assert(
    metadata.isFile() && !metadata.isSymbolicLink(),
    'Cloudflare verifier metadata must remain a regular file'
  );
  const source = fs.readFileSync(filePath);
  const sha256 = createHash('sha256').update(source).digest('hex');
  const existing = verifiedCloudflareMetadataSources.get(realFile);
  assert(
    !existing || existing.sha256 === sha256,
    'Cloudflare verifier metadata changed during verification'
  );
  verifiedCloudflareMetadataSources.set(realFile, { sha256 });
  return JSON.parse(source.toString('utf8'));
};
const matchingParsedModule = (cache, key, source) => {
  const cached = cache.get(key);
  if (!cached) return undefined;
  return cached.source === source ? cached : undefined;
};

const parseModuleSource = (filePath, source) => {
  const parsed = parseSync(filePath, source, { sourceType: 'module' });
  assert(
    parsed.errors.length === 0,
    `${filePath} must be parseable before checking server entry ownership`
  );
  return { program: parsed.program, source };
};

const readAuthenticatedModuleSource = (filePath) => {
  const authenticated = authenticatedCloudflareModuleSources.get(
    path.resolve(filePath)
  );
  if (authenticated) return authenticated.source;
  assert(
    authenticatedCloudflareModuleSources.size === 0,
    `Cloudflare parser requires a pre-authenticated lexical artifact path (${path.resolve(filePath)}; ${[
      ...authenticatedCloudflareModuleSources.keys(),
    ]
      .slice(0, 3)
      .join(', ')})`
  );
  return fs.readFileSync(filePath, 'utf8');
};

const cacheParsedModuleSource = (filePath, source, sourceDigest) => {
  const result = parseModuleSource(filePath, source);
  parsedModuleCache.set(filePath, result);
  parsedModuleSourceCache.set(sourceDigest, result);
  return result;
};

const readCachedParsedModule = (filePath, source) => {
  const cached = matchingParsedModule(parsedModuleCache, filePath, source);
  if (cached) return cached;
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  const sourceCached = matchingParsedModule(
    parsedModuleSourceCache,
    sourceDigest,
    source
  );
  if (!sourceCached) {
    return cacheParsedModuleSource(filePath, source, sourceDigest);
  }
  parsedModuleCache.set(filePath, sourceCached);
  return sourceCached;
};

const readParsedModule = (filePath) => {
  assertFile(filePath);
  const source = readAuthenticatedModuleSource(filePath);
  if (Buffer.byteLength(source, 'utf8') >= maximumCachedParsedModuleBytes) {
    return parseModuleSource(filePath, source);
  }
  return readCachedParsedModule(filePath, source);
};

const readNamespaceParsedModule = readParsedModule;

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
  if (profile === 'vercel') {
    assertVercelServerEntryOwners(filePath, entryCall);
  }
};

const assertVercelAwaitedOwnerImport = (
  program,
  filePath,
  names,
  sourcePattern
) => {
  const declarators = names.map((name) =>
    directVariableDeclarators(program, name)
  );
  assert(
    declarators.every(
      (matches) => matches.length === 1 && matches[0] === declarators[0][0]
    ),
    `${filePath} must import Vercel owners ${names.join(', ')} together exactly once`
  );
  const declarator = declarators[0][0];
  assert(
    shorthandBindingSignature(declarator) ===
      expectedShorthandBindingSignature(names),
    `${filePath} must import Vercel owners ${names.join(', ')} by exact shorthand`
  );
  assert(
    nodeType(declarator.init) === 'AwaitExpression',
    `${filePath} must await Vercel owner import ${names.join(', ')}`
  );
  const importSource = dynamicImportSource(declarator);
  assert(
    sourcePattern.test(importSource ?? ''),
    `${filePath} must import Vercel owners ${names.join(', ')} from their artifact chunk`
  );
  return { declarator, importSource };
};

const assertVercelServerEntryOwners = (filePath, entryCall) => {
  const { program } = readParsedModule(filePath);
  const artifactRoot = path.resolve(path.dirname(filePath), '..');
  const telemetry = assertVercelAwaitedOwnerImport(
    program,
    filePath,
    ['initVercelTelemetry', 'runWithVercelSentryRequestIsolation'],
    /^\.\.\/_libs\/[\w-]+\.mjs$/u
  );
  const lifecycle = assertVercelAwaitedOwnerImport(
    program,
    filePath,
    ['vercelRequestLifecycle'],
    /^\.\/request-lifecycle-[\w-]+\.mjs$/u
  );
  const application = assertVercelAwaitedOwnerImport(
    program,
    filePath,
    ['createApplicationServerEntry'],
    /^\.\/create-application-server-entry-[\w-]+\.mjs$/u
  );
  [telemetry, lifecycle, application].forEach(({ importSource }) =>
    resolveLinkedModule(filePath, importSource, artifactRoot)
  );
  const initializationCalls = directNamedCalls(program, 'initVercelTelemetry');
  assert(
    initializationCalls.length === 1 &&
      initializationCalls[0].arguments.length === 0,
    `${filePath} must initialize Vercel telemetry exactly once`
  );
  const [initializationCall] = initializationCalls;
  assert(
    telemetry.declarator.end < initializationCall.start &&
      initializationCall.end < lifecycle.declarator.start &&
      lifecycle.declarator.end < application.declarator.start &&
      application.declarator.end < entryCall.start,
    `${filePath} must initialize Vercel telemetry before lifecycle and application imports`
  );
  assertConditions(
    [
      entryCall.arguments.length === 3,
      literalString(entryCall.arguments[0]) === 'vercel',
      identifierName(entryCall.arguments[1]) === 'vercelRequestLifecycle',
      identifierName(entryCall.arguments[2]) ===
        'runWithVercelSentryRequestIsolation',
    ],
    `${filePath} must bind active Vercel lifecycle and request-isolation owners`
  );
  [
    'createApplicationServerEntry',
    'initVercelTelemetry',
    'runWithVercelSentryRequestIsolation',
    'vercelRequestLifecycle',
  ].forEach((name) =>
    assert(
      !mutatedNames(program).has(name),
      `${filePath} must not mutate Vercel owner ${name}`
    )
  );
};

const propertyKeyName = (property, bindings) =>
  new Set(['MethodDefinition', 'Property', 'PropertyDefinition']).has(
    property?.type
  )
    ? property.computed
      ? cloudflareLiteralMemberName(
          bindings
            ? resolveCloudflareTarget(property.key, bindings)
            : property.key
        )
      : (identifierName(property.key) ?? literalString(property.key))
    : undefined;

const identifierMemberSignature = ({ type, computed, object, property } = {}) =>
  [type, computed, identifierName(object), identifierName(property)].join(':');

const defaultExportEntries = (statement) => {
  if (statement.type === 'ExportDefaultDeclaration') {
    const localName = identifierName(statement.declaration);
    return localName ? [{ localName, statement }] : [];
  }
  return namedExportEntries(statement)
    .filter(([exportedName]) => exportedName === 'default')
    .map(([, localName]) => ({ localName, statement }));
};

const findDefaultWorkerFetch = (program, filePath) => {
  const defaultExports = program.body.flatMap(defaultExportEntries);
  assert(
    defaultExports.length === 1,
    `${filePath} must export one default Worker object`
  );
  const [defaultExport] = defaultExports;
  assert(
    !defaultExport.statement.source,
    `${filePath} must export one default Worker object`
  );
  const defaultLocalName = defaultExport.localName;
  const declarations = program.body.flatMap((statement) =>
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  );
  const workerOwners = declarations.filter(
    (declarator) => identifierName(declarator.id) === defaultLocalName
  );
  assert(
    workerOwners.length === 1,
    `${filePath} must export one default Worker object`
  );
  const [workerOwner] = workerOwners;
  assert(
    nodeType(workerOwner.init) === 'ObjectExpression',
    `${filePath} must export one default Worker object`
  );
  assert(
    !mutatedNames(program).has(defaultLocalName),
    `${filePath} must not mutate or alias the default Worker object`
  );
  assert(
    identifierOccurrenceCount(program, defaultLocalName) === 2,
    `${filePath} must not mutate or alias the default Worker object`
  );
  const workerProperties = ownerProperties(
    workerOwner.init,
    filePath,
    'the default Worker object'
  );
  const fetchFunction = workerProperties.get('fetch');
  assert(
    fetchFunction?.type === 'FunctionExpression',
    `${filePath} default Worker must own its fetch method`
  );
  return fetchFunction;
};

const directNamedCalls = (functionNode, localName) => {
  const allCalls = [];
  new Visitor({
    CallExpression(node) {
      allCalls.push(node);
    },
  }).visit(functionNode);
  const nestedRanges = nestedFunctionRanges(functionNode);
  return allCalls
    .filter((node) => identifierName(node.callee) === localName)
    .filter((node) => !isInsideNestedFunction(node, nestedRanges));
};

const namedCallsAnywhere = (node, localName) => {
  const calls = [];
  new Visitor({
    CallExpression(call) {
      if (identifierName(call.callee) === localName) calls.push(call);
    },
  }).visit(node);
  return calls;
};

const memberCallsAnywhere = (node, signature) => {
  const calls = [];
  new Visitor({
    CallExpression(call) {
      if (identifierMemberSignature(call.callee) === signature) {
        calls.push(call);
      }
    },
  }).visit(node);
  return calls;
};

const directReturnStatements = (functionNode) => {
  const allReturns = [];
  new Visitor({
    ReturnStatement(node) {
      allReturns.push(node);
    },
  }).visit(functionNode);
  const nestedRanges = nestedFunctionRanges(functionNode);
  return allReturns.filter(
    (node) => !isInsideNestedFunction(node, nestedRanges)
  );
};

const nodeRangeSignature = ({ start, end } = {}) => `${start}:${end}`;

const directVariableDeclarators = (functionNode, localName) => {
  const declarations = [];
  new Visitor({
    VariableDeclarator(node) {
      if (bindingNames(node.id).includes(localName)) declarations.push(node);
    },
  }).visit(functionNode);
  const nestedRanges = nestedFunctionRanges(functionNode);
  return declarations.filter(
    (declarator) => !isInsideNestedFunction(declarator, nestedRanges)
  );
};

const directVariableInitializer = (functionNode, localName) =>
  directVariableDeclarators(functionNode, localName)[0]?.init;

const noBodyStatements = () => [];
const blockBodyStatements = (body) => body.body;
const bodyStatementReaders = { BlockStatement: blockBodyStatements };
const directBodyStatements = ({ body = [] } = {}) =>
  Array.isArray(body)
    ? body
    : (bodyStatementReaders[nodeType(body)] ?? noBodyStatements)(body);

const matchingBodyDeclarators = (statement, localName, index) => {
  if (statement.type !== 'VariableDeclaration') return [];
  return statement.declarations
    .filter((declarator) => bindingNames(declarator.id).includes(localName))
    .map((declarator) => ({ declaration: statement, declarator, index }));
};

const directBodyVariableDeclarators = (functionNode, localName) => {
  const statements = directBodyStatements(functionNode);
  return statements.flatMap((statement, index) =>
    matchingBodyDeclarators(statement, localName, index)
  );
};

const topLevelVariableInitializer = (program, localName) =>
  program.body
    .flatMap((statement) =>
      statement.type === 'VariableDeclaration' ? statement.declarations : []
    )
    .find((declarator) => identifierName(declarator.id) === localName)?.init;

const artifactPatternTraversalDepthLimit = 128;
const artifactPatternTraversalDepthMessage =
  'artifact analysis exceeded bounded binding-pattern depth';

const artifactPatternChildren = (pattern) => {
  if (nodeType(pattern) === 'ArrayPattern') {
    return pattern.elements.filter(Boolean);
  }
  if (nodeType(pattern) === 'AssignmentPattern') return [pattern.left];
  if (nodeType(pattern) === 'ObjectPattern') {
    return pattern.properties.map(
      (property) => property.value ?? property.argument
    );
  }
  if (nodeType(pattern) === 'RestElement') return [pattern.argument];
  return [];
};

const inspectArtifactPattern = (pattern, inspect) => {
  const pending = [{ depth: 0, pattern }];
  let work = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current.pattern) continue;
    work += 1;
    assert(
      current.depth <= artifactPatternTraversalDepthLimit,
      artifactPatternTraversalDepthMessage
    );
    assert(
      work <= runtimeArtifactTraversalWorkLimit,
      runtimeArtifactTraversalWorkMessage
    );
    inspect(current.pattern);
    artifactPatternChildren(current.pattern)
      .toReversed()
      .forEach((child) =>
        pending.push({ depth: current.depth + 1, pattern: child })
      );
  }
};

const assertArtifactPatternBound = (pattern) =>
  inspectArtifactPattern(pattern, () => undefined);

const bindingNames = (pattern) => {
  const names = [];
  inspectArtifactPattern(pattern, (current) => {
    if (nodeType(current) === 'Identifier') names.push(current.name);
  });
  return names;
};

const isInsideContainingFunction = (node, ranges) =>
  ranges.some(
    ([start, end]) =>
      start <= node.start &&
      node.end <= end &&
      (start !== node.start || end !== node.end)
  );

const directCatchBindingNames = (functionNode, nestedRanges) => {
  const names = new Set();
  new Visitor({
    CatchClause(node) {
      if (isInsideNestedFunction(node, nestedRanges)) return;
      for (const name of bindingNames(node.param)) names.add(name);
    },
  }).visit(functionNode);
  return names;
};

const directDeclaredNames = (functionNode, nestedRanges, catchBindings) => {
  const names = new Set(catchBindings);
  new Visitor({
    ClassDeclaration(node) {
      if (isInsideContainingFunction(node, nestedRanges)) return;
      if (node.id) names.add(node.id.name);
    },
    FunctionDeclaration(node) {
      if (isInsideContainingFunction(node, nestedRanges)) return;
      if (node.id) names.add(node.id.name);
    },
    VariableDeclarator(node) {
      if (isInsideNestedFunction(node, nestedRanges)) return;
      for (const name of bindingNames(node.id)) names.add(name);
    },
  }).visit(functionNode);
  return names;
};

const noMutationRoot = () => undefined;
const mutationRootReaders = {
  Identifier: (node) => node.name,
  MemberExpression: (node) => mutationRootName(node.object),
};
const mutationRootName = (node) =>
  (mutationRootReaders[node?.type] ?? noMutationRoot)(node);

const mutationTargetNames = (node) => {
  const root = mutationRootName(node);
  return root ? [root] : bindingNames(node);
};

const addMutationTargetNames = (names, target) => {
  for (const name of mutationTargetNames(target)) names.add(name);
};

const mutatedNames = (functionNode) => {
  const names = new Set();
  new Visitor({
    AssignmentExpression(node) {
      addMutationTargetNames(names, node.left);
    },
    ForInStatement(node) {
      addMutationTargetNames(names, node.left);
    },
    ForOfStatement(node) {
      addMutationTargetNames(names, node.left);
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') {
        addMutationTargetNames(names, node.argument);
      }
    },
    UpdateExpression(node) {
      addMutationTargetNames(names, node.argument);
    },
  }).visit(functionNode);
  return names;
};

const cloudflareIdentityAliasSource = (node) => {
  if (nodeType(node) === 'Identifier') return node;
  if (nodeType(node) === 'SequenceExpression') {
    return cloudflareIdentityAliasSource(node.expressions.at(-1));
  }
  if (nodeType(node) === 'AssignmentExpression' && node.operator === '=') {
    return cloudflareIdentityAliasSource(node.right);
  }
  return undefined;
};

const cloudflareTopLevelAliasDeclarations = (program) =>
  program.body.flatMap((statement) => {
    const declaration = new Set([
      'ExportDefaultDeclaration',
      'ExportNamedDeclaration',
    ]).has(nodeType(statement))
      ? statement.declaration
      : statement;
    return nodeType(declaration) === 'VariableDeclaration'
      ? declaration.declarations.map((declarator) => ({
          digestNode: declarator,
          source: declarator.init,
          target: declarator.id,
        }))
      : [];
  });

const cloudflareMutationBindingIdentity = (node, name, context) => {
  const binding = artifactOwnerLexicalBinding(node, name, context);
  if (binding) return binding.digestNode;
  return context.importedNames.has(name) ? `import:${name}` : undefined;
};

const cloudflareMutationAliasReverseIndex = (program, context) => {
  const aliasesBySource = new Map();
  const record = (node, source, target) => {
    const sourceIdentifier = cloudflareIdentityAliasSource(source);
    if (!sourceIdentifier || nodeType(target) !== 'Identifier') return;
    const sourceIdentity = cloudflareMutationBindingIdentity(
      sourceIdentifier,
      sourceIdentifier.name,
      context
    );
    const targetIdentity = cloudflareMutationBindingIdentity(
      node,
      target.name,
      context
    );
    if (!sourceIdentity || !targetIdentity) return;
    const aliases = aliasesBySource.get(sourceIdentity) ?? [];
    aliases.push(targetIdentity);
    aliasesBySource.set(sourceIdentity, aliases);
  };
  new Visitor({
    AssignmentExpression(node) {
      if (node.operator === '=') record(node, node.right, node.left);
    },
    VariableDeclarator(node) {
      record(node, node.init, node.id);
    },
  }).visit(program);
  return aliasesBySource;
};

const cloudflareMutationAliasIdentities = (roots, aliasesBySource) => {
  const aliases = new Set(roots);
  const pending = [...aliases];
  while (pending.length > 0) {
    const sourceIdentity = pending.pop();
    (aliasesBySource.get(sourceIdentity) ?? []).forEach((identity) => {
      if (aliases.has(identity)) return;
      aliases.add(identity);
      pending.push(identity);
    });
  }
  return aliases;
};

const cloudflareMutationCalleeName = (node) => {
  if (nodeType(node) !== 'MemberExpression') return undefined;
  const member = staticMemberName(node);
  const object = node.object;
  if (nodeType(object) === 'Identifier') {
    return `${object.name}.${String(member)}`;
  }
  if (
    nodeType(object) === 'MemberExpression' &&
    identifierName(object.object) === 'globalThis'
  ) {
    return `${String(staticMemberName(object))}.${String(member)}`;
  }
  return undefined;
};

const cloudflareMutationIntrinsicNames = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
]);

const cloudflareDirectIntrinsicMutationTarget = (callee, arguments_) =>
  cloudflareMutationIntrinsicNames.has(cloudflareMutationCalleeName(callee))
    ? arguments_[0]
    : undefined;

const cloudflareStaticMutationArguments = (source, bindings) => {
  const resolved = resolveCloudflareTarget(source, bindings);
  assert(
    nodeType(resolved) === 'ArrayExpression' &&
      resolved.elements.every((element) => element !== null),
    cloudflareOpaqueApplyArgumentsMessage
  );
  return resolved.elements;
};

const cloudflarePotentialIntrinsicMutationTarget = (
  target,
  bindings,
  depth = 0
) => {
  if (depth > cloudflareFactoryResolutionLimit) return false;
  const resolved = resolveCloudflareTarget(target, bindings);
  if (
    cloudflareMutationIntrinsicNames.has(
      cloudflareMutationCalleeName(resolved)
    ) ||
    cloudflareMutationCalleeName(resolved) === 'Reflect.apply'
  ) {
    return true;
  }
  return (
    nodeType(resolved) === 'MemberExpression' &&
    new Set(['apply', 'call']).has(staticMemberName(resolved)) &&
    cloudflarePotentialIntrinsicMutationTarget(
      resolved.object,
      bindings,
      depth + 1
    )
  );
};

const cloudflareNormalizedIntrinsicMutationInvocation = (node, bindings) => {
  let callee = resolveCloudflareTarget(node.callee, bindings);
  let arguments_ = node.arguments;
  for (let depth = 0; depth <= cloudflareFactoryResolutionLimit; depth += 1) {
    const directTarget = cloudflareDirectIntrinsicMutationTarget(
      callee,
      arguments_
    );
    if (directTarget) return directTarget;
    if (
      nodeType(callee) === 'MemberExpression' &&
      new Set(['apply', 'call']).has(staticMemberName(callee)) &&
      cloudflarePotentialIntrinsicMutationTarget(callee.object, bindings)
    ) {
      const invocationKind = staticMemberName(callee);
      arguments_ =
        invocationKind === 'call'
          ? arguments_.slice(1)
          : cloudflareStaticMutationArguments(arguments_[1], bindings);
      callee = resolveCloudflareTarget(callee.object, bindings);
      continue;
    }
    if (cloudflareMutationCalleeName(callee) === 'Reflect.apply') {
      const target = resolveCloudflareTarget(arguments_[0], bindings);
      if (!cloudflarePotentialIntrinsicMutationTarget(target, bindings)) {
        return undefined;
      }
      callee = target;
      arguments_ = cloudflareStaticMutationArguments(arguments_[2], bindings);
      continue;
    }
    return undefined;
  }
  fail(cloudflareFactoryResolutionMessage);
};

const cloudflareLegacyMutationTarget = (callee) =>
  nodeType(callee) === 'MemberExpression' &&
  new Set(['__defineGetter__', '__defineSetter__']).has(
    staticMemberName(callee)
  )
    ? callee.object
    : undefined;

const cloudflareCallMutationTarget = (node, bindings) => {
  const callee = resolveCloudflareTarget(node.callee, bindings);
  return (
    cloudflareNormalizedIntrinsicMutationInvocation(node, bindings) ??
    cloudflareLegacyMutationTarget(callee)
  );
};

const cloudflareMutationTargetMatchesRoot = (node, target, context) =>
  mutationTargetNames(target).some((name) => {
    const identity = cloudflareMutationBindingIdentity(node, name, context);
    return identity && context.rootIdentities.has(identity);
  });

const cloudflareProgramMutationTargets = (program, bindings) => {
  const targets = [];
  const record = (node, target) => {
    if (target) targets.push({ node, target });
  };
  new Visitor({
    AssignmentExpression(node) {
      record(node, node.left);
    },
    CallExpression(node) {
      record(node, cloudflareCallMutationTarget(node, bindings));
    },
    ForInStatement(node) {
      record(node, node.left);
    },
    ForOfStatement(node) {
      record(node, node.left);
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') record(node, node.argument);
    },
    UpdateExpression(node) {
      record(node, node.argument);
    },
  }).visit(program);
  return targets;
};

const cloudflareMutationProgramIndexes = new WeakMap();
const cloudflareMutationProgramIndex = (program) => {
  const cached = cloudflareMutationProgramIndexes.get(program);
  if (cached) return cached;
  const bindings = cloudflareTopLevelBindings(program);
  const index = {
    bindings,
    declarationBindings: new Map(
      cloudflareTopLevelAliasDeclarations(program).flatMap(
        ({ digestNode, target }) =>
          bindingNames(target).map((name) => [name, digestNode])
      )
    ),
    importedNames: new Set(
      program.body
        .filter((statement) => nodeType(statement) === 'ImportDeclaration')
        .flatMap((statement) =>
          statement.specifiers.flatMap((specifier) => {
            const name = identifierName(specifier.local);
            return name ? [name] : [];
          })
        )
    ),
    lexicalBindingsByNode: new WeakMap(),
    lexicalEntriesByScope: new WeakMap(),
    parentNodes: createAstParentMap(program),
    program,
  };
  index.aliasesBySource = cloudflareMutationAliasReverseIndex(program, index);
  index.mutationTargets = cloudflareProgramMutationTargets(program, bindings);
  cloudflareMutationProgramIndexes.set(program, index);
  return index;
};

const cloudflareReturnedOwnersAreUnmutated = (program, roots) => {
  const index = cloudflareMutationProgramIndex(program);
  const rootIdentities = [...roots].flatMap((name) => {
    const declaration = index.declarationBindings.get(name);
    if (declaration) return [declaration];
    return index.importedNames.has(name) ? [`import:${name}`] : [];
  });
  const aliases = cloudflareMutationAliasIdentities(
    rootIdentities,
    index.aliasesBySource
  );
  const context = { ...index, rootIdentities: aliases };
  const mutated = index.mutationTargets.some(({ node, target }) =>
    cloudflareMutationTargetMatchesRoot(node, target, context)
  );
  if (mutated) return false;
  let escaped = false;
  new Visitor({
    CallExpression(node) {
      if (escaped) return;
      escaped = node.arguments.some((argument) => {
        const source = cloudflareIdentityAliasSource(argument);
        if (!source) return false;
        const identity = cloudflareMutationBindingIdentity(
          source,
          source.name,
          context
        );
        return identity && aliases.has(identity);
      });
    },
  }).visit(program);
  return !escaped;
};

const directAssignments = (functionNode, localName) => {
  const assignments = [];
  new Visitor({
    AssignmentExpression(node) {
      if (mutationTargetNames(node.left).includes(localName)) {
        assignments.push(node);
      }
    },
  }).visit(functionNode);
  const nestedRanges = nestedFunctionRanges(functionNode);
  return assignments.filter(
    (assignment) => !isInsideNestedFunction(assignment, nestedRanges)
  );
};

const assignmentsAnywhere = (node, localName) => {
  const assignments = [];
  new Visitor({
    AssignmentExpression(assignment) {
      if (mutationTargetNames(assignment.left).includes(localName)) {
        assignments.push(assignment);
      }
    },
  }).visit(node);
  return assignments;
};

const assertNoTrustedCloudflareOverrides = (declared, mutated, filePath) => {
  const trustedOwners = [
    'Sentry',
    'application',
    'configureCloudflareRequestTelemetry',
    'fetchCloudflareApplication',
    'runWithCloudflareDatabase',
    'scheduleCloudflareRequestFlush',
    'sentryRequestIsolationReady',
  ];
  for (const owner of trustedOwners) {
    assert(
      !declared.has(owner) && !mutated.has(owner),
      `${filePath} Worker fetch must not override trusted owner ${owner}`
    );
  }
};

const assertNoActiveParameterOverrides = (declared, mutated, filePath) => {
  const activeParameters = ['context', 'environment', 'request'];
  for (const parameter of activeParameters) {
    assert(
      !declared.has(parameter) && !mutated.has(parameter),
      `${filePath} Worker fetch must not override active parameter ${parameter}`
    );
  }
};

const assertNoActiveBindingOverrides = (catchBindings, mutated, filePath) => {
  const activeBindings = [
    'handleApplication',
    'handleDatabase',
    'sentryOptions',
  ];
  for (const binding of activeBindings) {
    assert(
      !mutated.has(binding),
      `${filePath} Worker fetch must not mutate active binding ${binding}`
    );
    assert(
      !catchBindings.has(binding),
      `${filePath} Worker fetch must not shadow active binding ${binding}`
    );
  }
};

const assertCloudflareNativeTelemetryOwner = (
  program,
  fetchFunction,
  sentryOptionsIndex,
  filePath
) => {
  const nativeOwners = directBodyVariableDeclarators(
    fetchFunction,
    'nativeTelemetry'
  );
  assert(
    nativeOwners.length === 1,
    `${filePath} Worker fetch must declare active native telemetry exactly once`
  );
  const [nativeOwner] = nativeOwners;
  assert(
    directVariableDeclarators(fetchFunction, 'nativeTelemetry').length === 1,
    `${filePath} Worker fetch must not reinitialize active native telemetry`
  );
  assert(
    nativeOwner.declaration.kind === 'let',
    `${filePath} Worker fetch must own mutable native telemetry locally`
  );
  assert(
    identifierName(nativeOwner.declarator.init) === 'lastKnownNativeTelemetry',
    `${filePath} Worker fetch must initialize active native telemetry from its safe fallback`
  );
  assert(
    nativeOwner.index < sentryOptionsIndex,
    `${filePath} Worker fetch must initialize native telemetry before Sentry options`
  );
  assert(
    sentryOptionsIndex > nativeOwner.index + 1,
    `${filePath} Worker fetch must directly configure native telemetry before Sentry`
  );
  const telemetryScope = fetchFunction.body.body[nativeOwner.index + 1];
  assert(
    nodeType(telemetryScope) === 'TryStatement',
    `${filePath} Worker fetch must directly configure native telemetry`
  );
  assert(
    telemetryScope.finalizer === null,
    `${filePath} Worker fetch must not defer native telemetry configuration`
  );
  assert(
    telemetryScope.block.body.length === 2,
    `${filePath} Worker fetch must install and retain one native telemetry adapter`
  );
  const retainedFallback = assertCloudflareNativeTelemetryInstall(
    telemetryScope.block.body,
    filePath
  );
  assertCloudflareNativeTelemetryFailure(telemetryScope.handler, filePath);
  const nativeAssignments = directAssignments(fetchFunction, 'nativeTelemetry');
  assert(
    nativeAssignments.length === 1,
    `${filePath} Worker fetch must assign active native telemetry exactly once`
  );
  assert(
    nativeAssignments[0] === telemetryScope.block.body[0].expression,
    `${filePath} Worker fetch must not reset native telemetry before Sentry setup`
  );
  assert(
    identifierOccurrenceCount(fetchFunction, 'nativeTelemetry') === 5,
    `${filePath} Worker fetch must not alias active native telemetry`
  );
  const fallbackOwners = topLevelBindingDeclarators(
    program,
    'lastKnownNativeTelemetry'
  );
  assert(
    fallbackOwners.length === 1,
    `${filePath} must declare one native telemetry fallback owner`
  );
  assert(
    identifierName(fallbackOwners[0].id) === 'lastKnownNativeTelemetry',
    `${filePath} must bind its native telemetry fallback directly`
  );
  const fallbackInitializer = unwrapAwaitExpression(fallbackOwners[0].init);
  assert(
    fallbackInitializer?.type === 'CallExpression',
    `${filePath} must initialize its native telemetry fallback`
  );
  assert(
    identifierName(fallbackInitializer.callee) === 'createNoOpTelemetry',
    `${filePath} must initialize native telemetry with the safe no-op adapter`
  );
  const fallbackAssignments = assignmentsAnywhere(
    program,
    'lastKnownNativeTelemetry'
  );
  assert(
    fallbackAssignments.length === 1 &&
      fallbackAssignments[0] === retainedFallback,
    `${filePath} must only retain the verified native telemetry adapter`
  );
  assert(
    identifierOccurrenceCount(program, 'lastKnownNativeTelemetry') === 3,
    `${filePath} must not alias its native telemetry fallback`
  );
};

const assertCloudflareNativeTelemetryInstall = (statements, filePath) => {
  const install = statements[0].expression;
  assert(
    nodeType(install) === 'AssignmentExpression',
    `${filePath} Worker fetch must assign active native telemetry directly`
  );
  assertConditions(
    [
      install.operator === '=',
      identifierName(install.left) === 'nativeTelemetry',
    ],
    `${filePath} Worker fetch must assign active native telemetry directly`
  );
  const createAdapter = unwrapAwaitExpression(install.right);
  assert(
    nodeType(createAdapter) === 'CallExpression',
    `${filePath} Worker fetch must create its native telemetry adapter directly`
  );
  assert(
    identifierName(createAdapter.callee) === 'createCloudflareTelemetryAdapter',
    `${filePath} Worker fetch must create its native telemetry adapter directly`
  );
  assert(
    createAdapter.arguments.length === 1,
    `${filePath} Worker fetch must pass one native telemetry input`
  );
  const adapterInput = ownerProperties(
    createAdapter.arguments[0],
    filePath,
    'the Cloudflare native telemetry adapter'
  );
  assert(
    adapterInput.size === 2,
    `${filePath} Worker fetch must pass exact native telemetry inputs`
  );
  assert(
    identifierMemberSignature(adapterInput.get('analytics')) ===
      'MemberExpression:false:environment:START_UI_TELEMETRY_METRICS',
    `${filePath} Worker fetch must use the active Analytics Engine binding`
  );
  assert(
    identifierName(adapterInput.get('tracing')) === 'tracing',
    `${filePath} Worker fetch must use active Cloudflare tracing`
  );
  const retain = statements[1].expression;
  assert(
    nodeType(retain) === 'AssignmentExpression',
    `${filePath} Worker fetch must retain the active native telemetry adapter`
  );
  assertConditions(
    [
      retain.operator === '=',
      identifierName(retain.left) === 'lastKnownNativeTelemetry',
      identifierName(retain.right) === 'nativeTelemetry',
    ],
    `${filePath} Worker fetch must retain the active native telemetry adapter`
  );
  return retain;
};

const assertCloudflareNativeTelemetryFailure = (handler, filePath) => {
  assert(
    nodeType(handler) === 'CatchClause',
    `${filePath} Worker fetch must isolate native telemetry setup failures`
  );
  assert(
    identifierName(handler.param) === 'failure',
    `${filePath} Worker fetch must classify native telemetry setup failures`
  );
  assert(
    handler.body.body.length === 1,
    `${filePath} Worker fetch must bound native telemetry setup failure handling`
  );
  const report = handler.body.body[0].expression;
  assert(
    nodeType(report) === 'CallExpression',
    `${filePath} Worker fetch must report native telemetry setup failures`
  );
  assertConditions(
    [
      identifierName(report.callee) === 'reportTelemetryFailure',
      literalString(report.arguments[0]) === 'otel.cloudflare.configure',
      identifierName(report.arguments[1]) === 'failure',
    ],
    `${filePath} Worker fetch must report bounded native telemetry setup diagnostics`
  );
};

const assertCloudflareSentryOptionsBinding = (
  program,
  fetchFunction,
  filePath
) => {
  const directDeclarators = directBodyVariableDeclarators(
    fetchFunction,
    'sentryOptions'
  );
  const declarators = directVariableDeclarators(fetchFunction, 'sentryOptions');
  assert(
    declarators.length === 1,
    `${filePath} Worker fetch must declare validated Sentry options exactly once`
  );
  assert(
    directDeclarators.length === 1,
    `${filePath} Worker fetch must declare validated Sentry options directly`
  );
  const [declarator] = declarators;
  const [directDeclarator] = directDeclarators;
  assert(
    directDeclarator.declarator === declarator,
    `${filePath} Worker fetch must use its direct validated Sentry options declaration`
  );
  assert(
    directDeclarator.declaration.kind === 'const',
    `${filePath} Worker fetch must keep validated Sentry options immutable`
  );
  assert(
    directDeclarator.declaration.declarations.length === 1,
    `${filePath} Worker fetch must isolate its validated Sentry options declaration`
  );
  assert(
    directDeclarator.index < fetchFunction.body.body.length - 1,
    `${filePath} Worker fetch must configure Sentry before its request owner`
  );
  assert(
    declarator.id.type === 'ObjectPattern',
    `${filePath} Worker fetch must destructure validated Sentry options`
  );
  assert(
    declarator.id.properties.length === 1,
    `${filePath} Worker fetch must bind only validated Sentry options`
  );
  const [property] = declarator.id.properties;
  assert(
    propertyKeyName(property) === 'sentryOptions',
    `${filePath} Worker fetch must bind the validated Sentry options property`
  );
  assert(
    identifierName(property.value) === 'sentryOptions',
    `${filePath} Worker fetch must preserve the validated Sentry options name`
  );
  assert(
    property.shorthand,
    `${filePath} Worker fetch must bind validated Sentry options by shorthand`
  );
  const initializer = unwrapAwaitExpression(declarator.init);
  assert(
    initializer?.type === 'CallExpression',
    `${filePath} Worker fetch must call request telemetry configuration`
  );
  assert(
    identifierName(initializer.callee) ===
      'configureCloudflareRequestTelemetry',
    `${filePath} Worker fetch must initialize validated Sentry options from request telemetry`
  );
  assert(
    initializer.arguments.length === 1,
    `${filePath} Worker fetch must pass one validated request telemetry input`
  );
  const configuration = ownerProperties(
    initializer.arguments[0],
    filePath,
    'the Cloudflare request telemetry configurator'
  );
  assert(
    configuration.size === 5,
    `${filePath} Cloudflare request telemetry configurator must receive the exact request inputs`
  );
  assert(
    identifierName(configuration.get('environment')) === 'environment',
    `${filePath} Cloudflare request telemetry configurator must receive the active environment`
  );
  assert(
    identifierName(configuration.get('nativeTelemetry')) === 'nativeTelemetry',
    `${filePath} Cloudflare request telemetry configurator must receive active native telemetry`
  );
  assert(
    identifierName(configuration.get('request')) === 'request',
    `${filePath} Cloudflare request telemetry configurator must receive the active request`
  );
  assert(
    identifierName(configuration.get('sentry')) === 'Sentry',
    `${filePath} Cloudflare request telemetry configurator must receive the initialized Sentry API`
  );
  assert(
    identifierName(configuration.get('sentryRequestIsolationReady')) ===
      'sentryRequestIsolationReady',
    `${filePath} Cloudflare request telemetry configurator must receive validated request isolation readiness`
  );
  assertCloudflareNativeTelemetryOwner(
    program,
    fetchFunction,
    directDeclarator.index,
    filePath
  );
};

const assertNoCloudflareOwnerOverrides = (program, fetchFunction, filePath) => {
  const nestedRanges = nestedFunctionRanges(fetchFunction);
  const catchBindings = directCatchBindingNames(fetchFunction, nestedRanges);
  const declared = directDeclaredNames(
    fetchFunction,
    nestedRanges,
    catchBindings
  );
  const mutated = mutatedNames(fetchFunction);
  assertNoTrustedCloudflareOverrides(declared, mutated, filePath);
  assertNoActiveParameterOverrides(declared, mutated, filePath);
  assertNoActiveBindingOverrides(catchBindings, mutated, filePath);
  assertCloudflareSentryOptionsBinding(program, fetchFunction, filePath);
};

const identifierOccurrenceCount = (functionNode, localName) => {
  let count = 0;
  new Visitor({
    Identifier(node) {
      if (node.name === localName) count += 1;
    },
  }).visit(functionNode);
  return count;
};

const assertExactCloudflareOwnerUsage = (fetchFunction, filePath) => {
  const exactUsages = [
    ['Sentry', 1],
    ['application', 1],
    ['configureCloudflareRequestTelemetry', 1],
    ['fetchCloudflareApplication', 1],
    ['runWithCloudflareDatabase', 1],
    ['scheduleCloudflareRequestFlush', 1],
  ];
  for (const [owner, expectedCount] of exactUsages) {
    assert(
      identifierOccurrenceCount(fetchFunction, owner) === expectedCount,
      `${filePath} Worker fetch must use trusted owner ${owner} exactly once`
    );
  }
};

const topLevelBindingDeclarators = (program, localName) =>
  program.body
    .flatMap((statement) =>
      statement.type === 'VariableDeclaration' ? statement.declarations : []
    )
    .filter((declarator) => bindingNames(declarator.id).includes(localName));

const noTopLevelDeclarations = () => [];
const variableDeclarationsForBinding = (statement, localName) =>
  statement.declarations
    .filter((declarator) => bindingNames(declarator.id).includes(localName))
    .map((declarator) => declarator.init);
const namedDeclarationForBinding = (statement, localName) =>
  identifierName(statement.id) === localName ? [statement] : [];
const importDeclarationsForBinding = (statement, localName) =>
  statement.specifiers
    .filter((specifier) => identifierName(specifier.local) === localName)
    .map(() => statement);
const topLevelDeclarationReaders = {
  ClassDeclaration: namedDeclarationForBinding,
  FunctionDeclaration: namedDeclarationForBinding,
  ImportDeclaration: importDeclarationsForBinding,
  VariableDeclaration: variableDeclarationsForBinding,
};

const topLevelDeclarationsForBinding = (program, localName) =>
  program.body.flatMap((statement) =>
    (topLevelDeclarationReaders[statement.type] ?? noTopLevelDeclarations)(
      statement,
      localName
    )
  );

const topLevelDeclaratorStatementIndex = (program, declarator) =>
  program.body.findIndex(
    (statement) =>
      statement.type === 'VariableDeclaration' &&
      statement.declarations.includes(declarator)
  );

const trustedOwnerBindingValidators = {
  application: (declarator) => {
    const initializer = unwrapAwaitExpression(declarator.init);
    return (
      initializer?.type === 'CallExpression' &&
      identifierName(initializer.callee) ===
        'initializeCloudflareSentryApplication'
    );
  },
  fetchCloudflareApplication: (declarator) =>
    declarator.init?.type === 'ArrowFunctionExpression',
  runWithCloudflareDatabase: (declarator) =>
    Boolean(dynamicImportSource(declarator)),
};

const hasIdentifierOutsideRanges = (program, localName, allowedRanges) => {
  let unexpected = false;
  new Visitor({
    Identifier(node) {
      if (node.name !== localName) return;
      if (!isInsideNestedFunction(node, allowedRanges)) unexpected = true;
    },
  }).visit(program);
  return unexpected;
};

const shorthandPropertySignature = (property = {}) =>
  [
    property.type,
    property.computed,
    property.shorthand,
    propertyKeyName(property),
    identifierName(property.value),
  ].join(':');

const shorthandBindingSignature = ({ id = {} } = {}) => {
  const properties = id.properties ?? [];
  return [
    id.type,
    properties.length,
    ...properties.map(shorthandPropertySignature),
  ].join('|');
};

const expectedShorthandBindingSignature = (names) =>
  [
    'ObjectPattern',
    names.length,
    ...names.map((name) => `Property:false:true:${name}:${name}`),
  ].join('|');

const shorthandObjectSignature = ({ properties = [] } = {}) =>
  [
    'ObjectExpression',
    properties.length,
    ...properties.map(shorthandPropertySignature),
  ].join('|');

const expectedShorthandObjectSignature = (names) =>
  [
    'ObjectExpression',
    names.length,
    ...names.map((name) => `Property:false:true:${name}:${name}`),
  ].join('|');

const assertCloudflareChunkLocalOwner = (
  program,
  chunkFile,
  exportedName,
  requiredCalls = [],
  requiredIdentifiers = []
) => {
  const exports = program.body
    .filter(
      (statement) =>
        statement.type === 'ExportNamedDeclaration' && !statement.source
    )
    .flatMap(namedExportEntries)
    .filter(([name]) => name === exportedName);
  assert(
    exports.length === 1 && exports[0][1] === exportedName,
    `${chunkFile} must export trusted owner ${exportedName} from one local binding`
  );
  const topLevelDeclarators = topLevelBindingDeclarators(program, exportedName);
  const declarators = directVariableDeclarators(program, exportedName);
  assert(
    topLevelDeclarators.length === 1,
    `${chunkFile} must define trusted owner ${exportedName} as one local function`
  );
  assert(
    declarators.length === 1,
    `${chunkFile} must define trusted owner ${exportedName} as one local function`
  );
  assert(
    topLevelDeclarators[0] === declarators[0],
    `${chunkFile} must define trusted owner ${exportedName} as one local function`
  );
  assert(
    isFunctionExpression(declarators[0].init),
    `${chunkFile} must define trusted owner ${exportedName} as one local function`
  );
  assert(
    !mutatedNames(program).has(exportedName),
    `${chunkFile} must not mutate trusted owner ${exportedName}`
  );
  for (const requiredCall of requiredCalls) {
    assert(
      directNamedCalls(declarators[0].init, requiredCall).length > 0,
      `${chunkFile} trusted owner ${exportedName} must call ${requiredCall}`
    );
  }
  for (const requiredIdentifier of requiredIdentifiers) {
    assert(
      identifierOccurrenceCount(declarators[0].init, requiredIdentifier) > 0,
      `${chunkFile} trusted owner ${exportedName} must use ${requiredIdentifier}`
    );
  }
};

const assertCloudflareNamedOwnerChunk = (
  entryFile,
  importSource,
  exportedNames,
  requiredCalls = {},
  requiredIdentifiers = {}
) => {
  const artifactRoot = path.dirname(entryFile);
  const chunkFile = path.resolve(artifactRoot, importSource);
  assert(
    isWithinDirectory(chunkFile, artifactRoot),
    `${entryFile} must keep trusted owners inside its artifact`
  );
  assertFile(chunkFile);
  const { program } = readParsedModule(chunkFile);
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    chunkFile,
    'runtime owner'
  );
  for (const exportedName of exportedNames) {
    assertCloudflareChunkLocalOwner(
      program,
      chunkFile,
      exportedName,
      requiredCalls[exportedName],
      requiredIdentifiers[exportedName]
    );
  }
  return { chunkFile, manifestRecord, program };
};

const assertCloudflareChunkProvenance = (
  entryFile,
  chunkFile,
  expectedSource,
  label
) => {
  const artifactRoot = path.dirname(entryFile);
  const source = assertCloudflareChunkManifestMembership(
    artifactRoot,
    chunkFile,
    label
  );
  assertConditions(
    [source.entry.isDynamicEntry === true, source.entry.src === expectedSource],
    `${chunkFile} must originate from ${expectedSource}`
  );
  return { ...readParsedModule(chunkFile), manifestRecord: source };
};

const assertCloudflareChunkManifestMembership = (
  artifactRoot,
  chunkFile,
  label
) => {
  assert(
    isWithinDirectory(chunkFile, artifactRoot),
    `${chunkFile} must keep ${label} inside its artifact`
  );
  assertFile(chunkFile);
  assert(
    isWithinDirectory(
      fs.realpathSync(chunkFile),
      fs.realpathSync(artifactRoot)
    ),
    `${chunkFile} must keep ${label} inside its artifact`
  );
  const manifestFile = path.join(artifactRoot, '.vite', 'manifest.json');
  // This checks that the emitted graph matches Vite's co-produced metadata.
  // It is drift detection, not cryptographic attestation of a hostile output.
  const manifest = readVerifiedCloudflareMetadataJson(manifestFile);
  const assetFile = path
    .relative(artifactRoot, chunkFile)
    .split(path.sep)
    .join('/');
  viteManifestEntries(manifest, manifestFile);
  const sources = Object.entries(manifest)
    .map(([key, entry]) => ({ entry, key }))
    .filter(({ entry }) => entry.file === assetFile);
  assert(
    sources.length === 1,
    `${chunkFile} must have one Vite ${label} provenance record`
  );
  return { ...sources[0], artifactRoot, manifest, manifestFile };
};

const assertCloudflareNamedOwnerImport = (
  program,
  filePath,
  { assetPattern, exportedNames, requiredCalls, requiredIdentifiers }
) => {
  const ownerDeclarators = exportedNames.map((owner) => {
    const declarators = topLevelBindingDeclarators(program, owner);
    assert(
      declarators.length === 1,
      `${filePath} must declare trusted owner ${owner} exactly once`
    );
    return declarators[0];
  });
  const [declarator] = ownerDeclarators;
  assert(
    ownerDeclarators.every((candidate) => candidate === declarator),
    `${filePath} must import trusted owners ${exportedNames.join(', ')} together`
  );
  assert(
    shorthandBindingSignature(declarator) ===
      expectedShorthandBindingSignature(exportedNames),
    `${filePath} must import trusted owner ${exportedNames[0]} by exact shorthand`
  );
  assert(
    nodeType(declarator.init) === 'AwaitExpression',
    `${filePath} must await trusted owner ${exportedNames[0]} import`
  );
  const importSource = dynamicImportSource(declarator);
  assert(
    assetPattern.test(importSource ?? ''),
    `${filePath} must initialize trusted owner ${exportedNames[0]} from its runtime owner`
  );
  const chunk = assertCloudflareNamedOwnerChunk(
    filePath,
    importSource,
    exportedNames,
    requiredCalls,
    requiredIdentifiers
  );
  return { ...chunk, declarator };
};

const assertCloudflareRequestTelemetryOwner = (
  program,
  fetchFunction,
  filePath
) => {
  const owner = 'configureCloudflareRequestTelemetry';
  const {
    chunkFile,
    declarator,
    manifestRecord,
    program: chunkProgram,
  } = assertCloudflareNamedOwnerImport(program, filePath, {
    assetPattern: /^\.\/assets\/request-telemetry(?:-[\w-]+)?\.js$/,
    exportedNames: [owner],
    requiredCalls: {
      [owner]: ['createCloudflareSentryOptions', 'setTelemetry'],
    },
  });
  assertCloudflareChunkProvenance(
    filePath,
    chunkFile,
    'src/runtime/cloudflare/request-telemetry.ts',
    'request telemetry owner'
  );
  assertCloudflareRequestTelemetryChunkBehavior(chunkProgram, chunkFile);
  assertExactCloudflareStaticImportSources(chunkProgram, chunkFile, [
    /^\.\/tags(?:-[\w-]+)?\.js$/,
    /^\.\/sanitize-log-fields(?:-[\w-]+)?\.js$/,
    /^\.\/telemetry(?:-[\w-]+)?\.js$/,
  ]);
  assertBoundedCloudflareChunkTopLevel(chunkProgram, chunkFile, manifestRecord);
  assert(
    !hasIdentifierOutsideRanges(program, owner, [
      [fetchFunction.start, fetchFunction.end],
      [declarator.id.start, declarator.id.end],
    ]),
    `${filePath} must not alias trusted owner ${owner}`
  );
};

const assertCloudflareLoaderKernelGuard = (loader, filePath) => {
  const message = `${filePath} application loader must run exact Cloudflare kernel guards`;
  assert(nodeType(loader.body) === 'BlockStatement', message);
  assert(loader.body.body.length === 5, message);
  const kernelOwners = directBodyVariableDeclarators(loader, 'kernel');
  assert(kernelOwners.length === 1 && kernelOwners[0].index === 0, message);
  assertExactDirectVariableOwner(kernelOwners[0], 'const', message);
  const kernelOwner = kernelOwners[0].declarator;
  assert(identifierName(kernelOwner.id) === 'kernel', message);
  assert(nodeType(kernelOwner.init) === 'AwaitExpression', message);
  const importSource = dynamicImportSource(kernelOwner);
  assert(
    /^\.\/assets\/backend(?:-[\w-]+)?\.js$/.test(importSource ?? ''),
    message
  );
  const kernelChunk = path.resolve(path.dirname(filePath), importSource);
  const { manifestRecord: kernelManifestRecord, program: kernelProgram } =
    assertCloudflareChunkProvenance(
      filePath,
      kernelChunk,
      'src/modules/kernel/backend.ts',
      'kernel owner'
    );
  assertCloudflareKernelChunk(kernelProgram, kernelChunk, kernelManifestRecord);
  const [requireStatement, validateStatement] = loader.body.body.slice(1, 3);
  assertCloudflareLoaderKernelCall(
    requireStatement,
    'requireRuntimeDatabaseClient',
    [],
    filePath
  );
  assertCloudflareLoaderKernelCall(
    validateStatement,
    'validateServerBuildConfig',
    ['cloudflare'],
    filePath
  );
  assert(!mutatedNames(loader).has('kernel'), message);
};

const assertCloudflareKernelHelper = (
  program,
  chunkFile,
  message,
  [owner, sourcePattern]
) => {
  const exports = program.body
    .flatMap(namedExportEntries)
    .filter(([exportedName]) => exportedName === owner);
  assert(
    exports.length === 1 && exports[0][1] === owner,
    `${message}: ${owner}`
  );
  assertExactStaticChunkHelper(program, chunkFile, owner, sourcePattern);
  assert(!mutatedNames(program).has(owner), `${message}: ${owner}`);
};

const kernelOptionalOwnerPatterns = {
  5: [],
  6: [/^\.\/book(?:-[\w-]+)?\.js$/],
};

const assertCloudflareKernelChunk = (program, chunkFile, manifestRecord) => {
  const message = `${chunkFile} must expose exact Cloudflare kernel guards`;
  [
    ['requireRuntimeDatabaseClient', /^\.\/client(?:-[\w-]+)?\.js$/],
    ['validateServerBuildConfig', /^\.\/backend(?:-[\w-]+)?\.js$/],
  ].forEach((helper) =>
    assertCloudflareKernelHelper(program, chunkFile, message, helper)
  );
  const sources = cloudflareStaticImportSources(program);
  assert(
    Object.hasOwn(kernelOptionalOwnerPatterns, sources.length),
    `${chunkFile} must import only its trusted static owner chunks`
  );
  assertExactCloudflareStaticImportSources(program, chunkFile, [
    /^\.\/auth(?:-[\w-]+)?\.js$/,
    /^\.\/telemetry(?:-[\w-]+)?\.js$/,
    /^\.\/client(?:-[\w-]+)?\.js$/,
    /^\.\/runtime(?:-[\w-]+)?\.js$/,
    /^\.\/backend(?:-[\w-]+)?\.js$/,
    ...kernelOptionalOwnerPatterns[sources.length],
  ]);
  assertBoundedCloudflareChunkTopLevel(program, chunkFile, manifestRecord);
};

const assertCloudflareLoaderKernelCall = (
  statement,
  method,
  literalArguments,
  filePath
) => {
  const message = `${filePath} application loader must run exact Cloudflare kernel guards`;
  assert(nodeType(statement) === 'ExpressionStatement', message);
  const call = statement.expression;
  assert(nodeType(call) === 'CallExpression', message);
  assertConditions(
    [
      identifierMemberSignature(call.callee) ===
        `MemberExpression:false:kernel:${method}`,
      call.arguments.length === literalArguments.length,
      call.arguments.map(literalString).join(':') ===
        literalArguments.join(':'),
    ],
    message
  );
};

const assertCloudflareApplicationLoader = (
  loader,
  filePath,
  tanStackOwnerDigests
) => {
  assert(
    loader?.type === 'ArrowFunctionExpression',
    `${filePath} must load the application through one async isolation callback`
  );
  assert(
    loader.async,
    `${filePath} must load the application through one async isolation callback`
  );
  assert(
    loader.params.length === 0,
    `${filePath} must load the application through one async isolation callback`
  );
  assertCloudflareLoaderKernelGuard(loader, filePath);
  const importedOwners = directBodyVariableDeclarators(
    loader,
    'createApplicationServerEntry'
  );
  assert(
    importedOwners.length === 1,
    `${filePath} must import one trusted application server-entry owner`
  );
  assert(
    importedOwners[0].index === 3,
    `${filePath} must import its application owner after Cloudflare kernel guards`
  );
  assertExactDirectVariableOwner(
    importedOwners[0],
    'const',
    `${filePath} must isolate its application server-entry owner`
  );
  const importedOwner = importedOwners[0].declarator;
  assert(
    directVariableDeclarators(loader, 'createApplicationServerEntry').length ===
      1,
    `${filePath} must not redeclare its application server-entry owner`
  );
  assert(
    shorthandBindingSignature(importedOwner) ===
      expectedShorthandBindingSignature(['createApplicationServerEntry']),
    `${filePath} must import createApplicationServerEntry by exact shorthand`
  );
  assert(
    nodeType(importedOwner.init) === 'AwaitExpression',
    `${filePath} must await the application server-entry import`
  );
  const importSource = dynamicImportSource(importedOwner);
  assert(
    /^\.\/assets\/create-application-server-entry(?:-[\w-]+)?\.js$/.test(
      importSource ?? ''
    ),
    `${filePath} must import the trusted application server-entry chunk`
  );
  const applicationChunk = path.resolve(path.dirname(filePath), importSource);
  assert(
    isWithinDirectory(applicationChunk, path.dirname(filePath)),
    `${filePath} must keep its application server-entry owner inside the artifact`
  );
  assertFile(applicationChunk);
  assertCloudflareApplicationChunkProvenance(
    applicationChunk,
    filePath,
    tanStackOwnerDigests
  );
  assert(
    !mutatedNames(loader).has('createApplicationServerEntry'),
    `${filePath} must not mutate its application server-entry owner`
  );
  const calls = directNamedCalls(loader, 'createApplicationServerEntry');
  assert(
    calls.length === 1,
    `${filePath} must create the Cloudflare application inside request isolation`
  );
  assertConditions(
    [
      calls[0].arguments.length === 1,
      literalString(calls[0].arguments[0]) === 'cloudflare',
    ],
    `${filePath} must create the Cloudflare application inside request isolation`
  );
  assert(
    importedOwner.end < calls[0].start,
    `${filePath} must import createApplicationServerEntry before using it`
  );
  const returns = directReturnStatements(loader);
  assert(
    returns.length === 1,
    `${filePath} must return its isolated Cloudflare application`
  );
  assert(
    loader.body.body[4] === returns[0],
    `${filePath} must return its isolated Cloudflare application after kernel guards`
  );
  assert(
    nodeRangeSignature(unwrapAwaitExpression(returns[0].argument)) ===
      nodeRangeSignature(calls[0]),
    `${filePath} must return its isolated Cloudflare application`
  );
};

const assertExactDirectVariableOwner = (owner, kind, message) =>
  assertConditions(
    [
      owner.declaration.kind === kind,
      owner.declaration.declarations.length === 1,
      owner.declaration.declarations[0] === owner.declarator,
    ],
    message
  );

const assertUniversalApplicationFrameworkFailure = (
  handler,
  applicationChunk
) => {
  const message = `${applicationChunk} universal request owner must preserve framework failures`;
  assert(nodeType(handler) === 'CatchClause', message);
  assert(identifierName(handler.param) === 'error', message);
  assert(handler.body.body.length === 2, message);
  const [captureGuard, catchTail] = handler.body.body;
  assert(nodeType(captureGuard) === 'IfStatement', message);
  assert(nodeType(captureGuard.test) === 'LogicalExpression', message);
  assert(nodeType(captureGuard.consequent) === 'ExpressionStatement', message);
  assertConditions(
    [captureGuard.alternate === null, captureGuard.test.operator === '&&'],
    message
  );
  const unexpectedFailure = captureGuard.test.left;
  const captureClaim = captureGuard.test.right;
  assert(nodeType(unexpectedFailure) === 'CallExpression', message);
  assert(nodeType(captureClaim) === 'CallExpression', message);
  assertConditions(
    [
      identifierName(unexpectedFailure.callee) === 'isUnexpectedRequestFailure',
      unexpectedFailure.arguments.map(identifierName).join(':') === 'error',
      identifierName(captureClaim.callee) === 'claimRequestException',
      captureClaim.arguments.map(identifierName).join(':') ===
        'telemetryCaptureState:error',
    ],
    message
  );
  assertUniversalApplicationExceptionCapture(
    captureGuard.consequent.expression,
    applicationChunk
  );
  assertConditions(
    [
      nodeType(catchTail) === 'ThrowStatement',
      identifierName(catchTail.argument) === 'error',
    ],
    message
  );
};

const assertUniversalApplicationExceptionCapture = (
  captureCall,
  applicationChunk
) => {
  const message = `${applicationChunk} universal request owner must capture unexpected framework failures`;
  assert(nodeType(captureCall) === 'CallExpression', message);
  assertConditions(
    [
      identifierMemberSignature(captureCall.callee) ===
        'MemberExpression:false:telemetryProxy:captureException',
      captureCall.arguments.length === 2,
      identifierName(captureCall.arguments[0]) === 'error',
    ],
    message
  );
  const options = ownerProperties(
    captureCall.arguments[1],
    applicationChunk,
    'the universal framework exception capture'
  );
  const tags = ownerProperties(
    options.get('tags'),
    applicationChunk,
    'the universal framework exception tags'
  );
  assertConditions(
    [
      options.size === 2,
      literalString(options.get('level')) === 'error',
      tags.size === 2,
      literalString(tags.get('event')) === 'framework.request.failed',
      identifierMemberSignature(tags.get('requestId')) ===
        'MemberExpression:false:context:requestId',
    ],
    message
  );
};

const assertUniversalApplicationFrameworkCall = (scope, applicationChunk) => {
  const message = `${applicationChunk} must execute the live TanStack application request path`;
  assert(nodeType(scope) === 'TryStatement', message);
  assert(scope.block.body.length === 1, message);
  const [frameworkReturn] = scope.block.body;
  assert(nodeType(frameworkReturn) === 'ReturnStatement', message);
  assert(nodeType(frameworkReturn.argument) === 'AwaitExpression', message);
  const frameworkCall = frameworkReturn.argument.argument;
  assert(nodeType(frameworkCall) === 'CallExpression', message);
  assert(nodeType(frameworkCall.callee) === 'MemberExpression', message);
  assertConditions(
    [
      identifierName(frameworkCall.callee.property) === 'fetch',
      identifierMemberSignature(frameworkCall.callee.object) ===
        'MemberExpression:false:tanstack:default',
      frameworkCall.arguments.length === 2,
      identifierName(frameworkCall.arguments[0]) === 'request',
    ],
    message
  );
  const requestOptions = ownerProperties(
    frameworkCall.arguments[1],
    applicationChunk,
    'the universal TanStack request options'
  );
  assertConditions(
    [
      requestOptions.size === 1,
      identifierName(requestOptions.get('context')) === 'context',
    ],
    message
  );
  assertUniversalApplicationFrameworkFailure(scope.handler, applicationChunk);
};

const assertUniversalApplicationLifecycle = (scope, applicationChunk) => {
  const message = `${applicationChunk} universal request owner must settle its active lifecycle`;
  assert(nodeType(scope.finalizer) === 'BlockStatement', message);
  assert(scope.finalizer.body.length === 1, message);
  const [lifecycleScope] = scope.finalizer.body;
  assert(nodeType(lifecycleScope) === 'TryStatement', message);
  assert(nodeType(lifecycleScope.block) === 'BlockStatement', message);
  assert(nodeType(lifecycleScope.handler) === 'CatchClause', message);
  assert(nodeType(lifecycleScope.handler.body) === 'BlockStatement', message);
  assertConditions(
    [
      lifecycleScope.block.body.length === 1,
      lifecycleScope.finalizer === null,
      lifecycleScope.handler.body.body.length === 0,
    ],
    message
  );
  const lifecycleStatement = lifecycleScope.block.body[0];
  assert(nodeType(lifecycleStatement) === 'ExpressionStatement', message);
  const lifecycleCall = unwrapChainExpression(lifecycleStatement.expression);
  assert(nodeType(lifecycleCall) === 'CallExpression', message);
  assertConditions(
    [
      identifierMemberSignature(lifecycleCall.callee) ===
        'MemberExpression:false:lifecycle:onRequestSettled',
      lifecycleCall.arguments.length === 1,
      identifierName(lifecycleCall.arguments[0]) === 'request',
    ],
    message
  );
};

const assertUniversalApplicationCaptureState = (
  captureDeclaration,
  message
) => {
  assert(nodeType(captureDeclaration) === 'VariableDeclaration', message);
  assertConditions(
    [
      captureDeclaration.kind === 'const',
      captureDeclaration.declarations.length === 1,
    ],
    message
  );
  const [captureOwner] = captureDeclaration.declarations;
  const captureCall = captureOwner.init;
  assert(identifierName(captureOwner.id) === 'telemetryCaptureState', message);
  assert(nodeType(captureCall) === 'CallExpression', message);
  assertConditions(
    [
      identifierName(captureCall.callee) ===
        'createRequestExceptionCaptureState',
      captureCall.arguments.length === 0,
    ],
    message
  );
};

const assertUniversalApplicationRequestBinding = (bindStatement, message) => {
  assert(nodeType(bindStatement) === 'ExpressionStatement', message);
  const bindCall = bindStatement?.expression;
  assert(nodeType(bindCall) === 'CallExpression', message);
  assertConditions(
    [
      identifierName(bindCall.callee) === 'bindRequestExceptionState',
      bindCall.arguments.map(identifierName).join(':') ===
        'request:telemetryCaptureState',
    ],
    message
  );
};

const assertUniversalApplicationContext = (
  contextDeclaration,
  applicationChunk,
  message
) => {
  assert(nodeType(contextDeclaration) === 'VariableDeclaration', message);
  assertConditions(
    [
      contextDeclaration.kind === 'const',
      contextDeclaration.declarations.length === 1,
      identifierName(contextDeclaration.declarations[0].id) === 'context',
    ],
    message
  );
  const context = ownerProperties(
    contextDeclaration.declarations[0].init,
    applicationChunk,
    'the universal request context'
  );
  const requestId = context.get('requestId');
  assert(nodeType(requestId) === 'CallExpression', message);
  assertConditions(
    [
      context.size === 3,
      identifierMemberSignature(requestId.callee) ===
        'MemberExpression:false:crypto:randomUUID',
      requestId.arguments.length === 0,
      identifierName(context.get('runtimeProfile')) === 'runtimeProfile',
      identifierName(context.get('telemetryCaptureState')) ===
        'telemetryCaptureState',
    ],
    message
  );
};

const assertUniversalApplicationRequestPrelude = (
  statements,
  applicationChunk
) => {
  const message = `${applicationChunk} universal request owner must establish exact request state`;
  const [captureDeclaration, bindStatement, contextDeclaration] = statements;
  assertUniversalApplicationCaptureState(captureDeclaration, message);
  assertUniversalApplicationRequestBinding(bindStatement, message);
  assertUniversalApplicationContext(
    contextDeclaration,
    applicationChunk,
    message
  );
};

const assertUniversalApplicationRequestHandler = (
  fetchOwner,
  applicationChunk
) => {
  const message = `${applicationChunk} universal application server entry must own one live request handler`;
  assert(nodeType(fetchOwner) === 'FunctionExpression', message);
  assert(nodeType(fetchOwner.body) === 'BlockStatement', message);
  assertConditions(
    [
      fetchOwner.async,
      fetchOwner.generator === false,
      fetchOwner.params.map(identifierName).join(':') === 'request',
      fetchOwner.body.body.length === 5,
    ],
    message
  );
  const handleOwners = directBodyVariableDeclarators(
    fetchOwner,
    'handleRequest'
  );
  assert(handleOwners.length === 1 && handleOwners[0].index === 0, message);
  assertExactDirectVariableOwner(handleOwners[0], 'const', message);
  const handleRequest = handleOwners[0].declarator.init;
  assert(nodeType(handleRequest) === 'ArrowFunctionExpression', message);
  assert(nodeType(handleRequest.body) === 'BlockStatement', message);
  assertConditions(
    [
      handleRequest.async,
      handleRequest.params.length === 0,
      handleRequest.body.body.length === 4,
    ],
    message
  );
  assertUniversalApplicationRequestPrelude(
    handleRequest.body.body.slice(0, 3),
    applicationChunk
  );
  const frameworkScope = handleRequest.body.body[3];
  assertUniversalApplicationFrameworkCall(frameworkScope, applicationChunk);
  assertUniversalApplicationLifecycle(frameworkScope, applicationChunk);
  assertUniversalApplicationScope(fetchOwner.body.body, applicationChunk);
};

const assertUniversalApplicationScope = (statements, applicationChunk) => {
  const message = `${applicationChunk} universal request owner must execute its application exactly once`;
  const [requestOwner, disabledScope, resultOwner, runnerOwner, scope] =
    statements;
  assert(nodeType(requestOwner) === 'VariableDeclaration', message);
  assert(nodeType(disabledScope) === 'IfStatement', message);
  assert(nodeType(disabledScope.test) === 'UnaryExpression', message);
  assert(nodeType(disabledScope.consequent) === 'ReturnStatement', message);
  const disabledCall = disabledScope.consequent.argument;
  assert(nodeType(disabledCall) === 'CallExpression', message);
  assertConditions(
    [
      disabledScope.alternate === null,
      disabledScope.test.operator === '!',
      identifierName(disabledScope.test.argument) === 'requestScope',
      identifierName(disabledCall.callee) === 'handleRequest',
      disabledCall.arguments.length === 0,
    ],
    message
  );
  assert(nodeType(resultOwner) === 'VariableDeclaration', message);
  assertConditions(
    [
      resultOwner.kind === 'let',
      resultOwner.declarations.length === 1,
      identifierName(resultOwner.declarations[0]?.id) === 'applicationResult',
      resultOwner.declarations[0]?.init === null,
    ],
    message
  );
  assertUniversalApplicationRunner(runnerOwner, applicationChunk);
  assertUniversalApplicationScopeFallback(scope, applicationChunk);
};

const assertUniversalApplicationRunner = (statement, applicationChunk) => {
  const message = `${applicationChunk} universal request owner must memoize one application execution`;
  assert(nodeType(statement) === 'VariableDeclaration', message);
  assertConditions(
    [statement.kind === 'const', statement.declarations.length === 1],
    message
  );
  const [runner] = statement.declarations;
  assert(identifierName(runner.id) === 'runApplicationOnce', message);
  assert(nodeType(runner.init) === 'ArrowFunctionExpression', message);
  assert(nodeType(runner.init.body) === 'BlockStatement', message);
  assertConditions(
    [runner.init.params.length === 0, runner.init.body.body.length === 2],
    message
  );
  const [memoizeStatement, runnerReturn] = runner.init.body.body;
  const memoize = memoizeStatement?.expression;
  assert(nodeType(memoizeStatement) === 'ExpressionStatement', message);
  assert(nodeType(memoize) === 'AssignmentExpression', message);
  assert(nodeType(memoize.right) === 'CallExpression', message);
  assertConditions(
    [
      memoize.operator === '??=',
      identifierName(memoize.left) === 'applicationResult',
      identifierName(memoize.right.callee) === 'handleRequest',
      memoize.right.arguments.length === 0,
      nodeType(runnerReturn) === 'ReturnStatement',
      identifierName(runnerReturn.argument) === 'applicationResult',
    ],
    message
  );
};

const assertUniversalApplicationScopeFallback = (scope, applicationChunk) => {
  const message = `${applicationChunk} universal request owner must preserve scoped execution`;
  assert(nodeType(scope) === 'TryStatement', message);
  assert(nodeType(scope.block) === 'BlockStatement', message);
  assert(nodeType(scope.handler) === 'CatchClause', message);
  assert(nodeType(scope.handler.body) === 'BlockStatement', message);
  assertConditions(
    [
      scope.block.body.length === 1,
      scope.finalizer === null,
      identifierName(scope.handler.param) === 'failure',
      scope.handler.body.body.length === 2,
    ],
    message
  );
  const scopedReturn = scope.block.body[0];
  assert(nodeType(scopedReturn) === 'ReturnStatement', message);
  const scopedCall = scopedReturn.argument;
  assert(nodeType(scopedCall) === 'CallExpression', message);
  assertConditions(
    [
      identifierName(scopedCall.callee) === 'requestScope',
      scopedCall.arguments.length === 1,
      identifierName(scopedCall.arguments[0]) === 'runApplicationOnce',
    ],
    message
  );
  const [reportStatement, fallbackReturn] = scope.handler.body.body;
  const reportCall = reportStatement?.expression;
  assert(nodeType(reportStatement) === 'ExpressionStatement', message);
  assert(nodeType(reportCall) === 'CallExpression', message);
  assert(nodeType(fallbackReturn) === 'ReturnStatement', message);
  assert(nodeType(fallbackReturn.argument) === 'LogicalExpression', message);
  const fallbackCall = fallbackReturn.argument.right;
  assert(nodeType(fallbackCall) === 'CallExpression', message);
  assertConditions(
    [
      identifierName(reportCall.callee) === 'reportTelemetryFailure',
      reportCall.arguments.length === 2,
      literalString(reportCall.arguments[0]) === 'sentry.request_scope',
      identifierName(reportCall.arguments[1]) === 'failure',
      fallbackReturn.argument.operator === '??',
      identifierName(fallbackReturn.argument.left) === 'applicationResult',
      identifierName(fallbackCall.callee) === 'runApplicationOnce',
      fallbackCall.arguments.length === 0,
    ],
    message
  );
};

const assertCloudflareApplicationDynamicImport = (
  owner,
  applicationChunk,
  applicationManifestRecord,
  [index, ownerName, sourcePattern, expectedSource]
) => {
  const imports = directBodyVariableDeclarators(owner, ownerName);
  assert(
    imports.length === 1,
    `${applicationChunk} must import trusted ${ownerName} exactly once`
  );
  assert(
    imports[0].index === index,
    `${applicationChunk} must import trusted owners before returning the application`
  );
  assertExactDirectVariableOwner(
    imports[0],
    'const',
    `${applicationChunk} must isolate trusted ${ownerName} import`
  );
  assert(
    nodeType(imports[0].declarator.init) === 'AwaitExpression',
    `${applicationChunk} must await trusted ${ownerName} import`
  );
  const importSource = dynamicImportSource(imports[0].declarator);
  assert(
    sourcePattern.test(importSource ?? ''),
    `${applicationChunk} must import trusted ${ownerName} from its owner chunk`
  );
  const importedChunk = path.resolve(
    path.dirname(applicationChunk),
    importSource
  );
  const manifestRecord = assertCloudflareChunkManifestMembership(
    applicationManifestRecord.artifactRoot,
    importedChunk,
    `dynamic ${ownerName} owner`
  );
  assertConditions(
    [
      manifestRecord.entry.isDynamicEntry === true,
      manifestRecord.entry.src === expectedSource,
    ],
    `${importedChunk} must originate from ${expectedSource}`
  );
  return { importedChunk, manifestRecord };
};

const assertCloudflareApplicationChunkImports = (
  owner,
  applicationChunk,
  applicationManifestRecord,
  tanStackOwnerDigests
) => {
  const dynamicOwners = [
    [
      0,
      'telemetryProxy',
      /^\.\/telemetry(?:-[\w-]+)?\.js$/,
      'src/platform/telemetry/index.ts',
    ],
    [
      1,
      'tanstack',
      /^\.\/entry-server(?:-[\w-]+)?\.js$/,
      'src/entry-server.ts',
    ],
  ].map((configuration) =>
    assertCloudflareApplicationDynamicImport(
      owner,
      applicationChunk,
      applicationManifestRecord,
      configuration
    )
  );
  const tanStackOwner = dynamicOwners[1];
  assertCloudflareTanStackEntryChunk(
    readParsedModule(tanStackOwner.importedChunk).program,
    tanStackOwner.importedChunk,
    tanStackOwner.manifestRecord,
    tanStackOwnerDigests
  );
  const dynamicRecords = dynamicOwners.map(
    ({ manifestRecord }) => manifestRecord.key
  );
  const expectedDynamicImports = applicationManifestRecord.entry.dynamicImports;
  assert(
    Array.isArray(expectedDynamicImports) &&
      exactSortedValues(dynamicRecords, expectedDynamicImports),
    `${applicationChunk} must preserve its exact Vite dynamic import graph`
  );
};

const assertUniversalApplicationHelperProvenance = (
  program,
  applicationChunk,
  applicationManifestRecord
) => {
  const helperOwners = [
    ['reportTelemetryFailure', /^\.\/telemetry(?:-[\w-]+)?\.js$/],
    ['claimRequestException', /^\.\/request-exception-state(?:-[\w-]+)?\.js$/],
    [
      'createRequestExceptionCaptureState',
      /^\.\/request-exception-state(?:-[\w-]+)?\.js$/,
    ],
    [
      'bindRequestExceptionState',
      /^\.\/request-exception-state(?:-[\w-]+)?\.js$/,
    ],
    ['isUnexpectedRequestFailure', /^\.\/request-failure(?:-[\w-]+)?\.js$/],
  ];
  const helperRecords = helperOwners.map(([helper, sourcePattern]) =>
    assertExactStaticChunkHelper(
      program,
      applicationChunk,
      helper,
      sourcePattern
    )
  );
  const helperKeys = new Set(
    helperRecords.map(({ manifestRecord }) => manifestRecord.key)
  );
  const applicationImports = applicationManifestRecord.entry.imports;
  assert(
    Array.isArray(applicationImports),
    `${applicationChunk} must declare its trusted helper graph in the Vite manifest`
  );
  assert(
    exactSortedValues([...helperKeys], applicationImports),
    `${applicationChunk} must import exactly its trusted helper manifest records`
  );
};

const assertCloudflareApplicationChunkBehavior = (
  program,
  applicationChunk,
  applicationManifestRecord,
  tanStackOwnerDigests
) => {
  assertCloudflareChunkLocalOwner(
    program,
    applicationChunk,
    'createApplicationServerEntry'
  );
  const owner = topLevelVariableInitializer(
    program,
    'createApplicationServerEntry'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression' && owner.async,
    `${applicationChunk} universal application server entry must be async`
  );
  assert(
    owner.params.map(identifierName).join(':') ===
      'runtimeProfile:lifecycle:requestScope',
    `${applicationChunk} universal application server entry must accept exact owners`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement' && owner.body.body.length === 3,
    `${applicationChunk} must import owners before returning one TanStack server entry`
  );
  assertUniversalApplicationHelperProvenance(
    program,
    applicationChunk,
    applicationManifestRecord
  );
  assertCloudflareApplicationChunkImports(
    owner,
    applicationChunk,
    applicationManifestRecord,
    tanStackOwnerDigests
  );
  const applicationReturn = owner.body.body[2];
  assert(
    nodeType(applicationReturn) === 'ReturnStatement',
    `${applicationChunk} must return one TanStack server entry`
  );
  const createEntry = applicationReturn.argument;
  assert(
    nodeType(createEntry) === 'CallExpression',
    `${applicationChunk} must return one TanStack server entry`
  );
  assertConditions(
    [
      identifierMemberSignature(createEntry.callee) ===
        'MemberExpression:false:tanstack:createServerEntry',
      createEntry.arguments.length === 1,
    ],
    `${applicationChunk} must return one TanStack server entry`
  );
  const entryOptions = ownerProperties(
    createEntry.arguments[0],
    applicationChunk,
    'the universal TanStack server entry'
  );
  assert(
    entryOptions.size === 1 && entryOptions.has('fetch'),
    `${applicationChunk} must return one TanStack request owner`
  );
  assertUniversalApplicationRequestHandler(
    entryOptions.get('fetch'),
    applicationChunk
  );
  assertTrustedChunkBuiltIns(program, applicationChunk, { crypto: 1 });
  assertExactCloudflareStaticImportSources(program, applicationChunk, [
    /^\.\/telemetry(?:-[\w-]+)?\.js$/,
    /^\.\/request-exception-state(?:-[\w-]+)?\.js$/,
    /^\.\/request-failure(?:-[\w-]+)?\.js$/,
  ]);
  assertBoundedCloudflareChunkTopLevel(
    program,
    applicationChunk,
    applicationManifestRecord
  );
};

const assertCloudflareApplicationChunkProvenance = (
  applicationChunk,
  entryFile,
  tanStackOwnerDigests
) => {
  const artifactRoot = path.dirname(entryFile);
  const source = assertCloudflareChunkManifestMembership(
    artifactRoot,
    applicationChunk,
    'application'
  );
  assertConditions(
    [
      source.entry.isDynamicEntry === true,
      source.entry.src === 'src/runtime/create-application-server-entry.ts',
    ],
    `${applicationChunk} must originate from the universal application server entry`
  );
  const { program } = readParsedModule(applicationChunk);
  assertCloudflareApplicationChunkBehavior(
    program,
    applicationChunk,
    source,
    tanStackOwnerDigests
  );
};

const assertCloudflareApplicationInitializer = (
  initializer,
  filePath,
  tanStackOwnerDigests
) => {
  assert(
    initializer?.type === 'CallExpression',
    `${filePath} must initialize the application through Cloudflare Sentry isolation`
  );
  assert(
    identifierName(initializer.callee) ===
      'initializeCloudflareSentryApplication',
    `${filePath} must initialize the application through Cloudflare Sentry isolation`
  );
  assert(
    initializer.arguments.length === 2,
    `${filePath} must initialize request isolation with the active Sentry API`
  );
  assert(
    identifierName(initializer.arguments[0]) === 'Sentry',
    `${filePath} must initialize request isolation with the active Sentry API`
  );
  assertCloudflareApplicationLoader(
    initializer.arguments[1],
    filePath,
    tanStackOwnerDigests
  );
};

const assertSharedTopLevelBindingDeclarator = (
  program,
  ownerNames,
  declarationMessage,
  sharedMessage
) => {
  const declarators = ownerNames.map((owner) => {
    const matches = topLevelBindingDeclarators(program, owner);
    assert(matches.length === 1, declarationMessage(owner));
    return matches[0];
  });
  const [declarator] = declarators;
  assert(
    declarators.every((candidate) => candidate === declarator),
    sharedMessage
  );
  return declarator;
};

const assertCloudflareApplicationOwner = (
  program,
  filePath,
  tanStackOwnerDigests
) => {
  const ownerNames = ['application', 'sentryRequestIsolationReady'];
  const declarator = assertSharedTopLevelBindingDeclarator(
    program,
    ownerNames,
    (owner) => `${filePath} must declare trusted owner ${owner} exactly once`,
    `${filePath} must initialize application and request isolation together`
  );
  assert(
    shorthandBindingSignature(declarator) ===
      expectedShorthandBindingSignature(ownerNames),
    `${filePath} must bind application and request isolation by exact shorthand`
  );
  assert(
    nodeType(declarator.init) === 'AwaitExpression',
    `${filePath} must await application request isolation initialization`
  );
  const initializer = declarator.init.argument;
  assertCloudflareApplicationInitializer(
    initializer,
    filePath,
    tanStackOwnerDigests
  );
  assert(
    directVariableDeclarators(program, 'application').length === 1,
    `${filePath} must not reinitialize application request isolation owners`
  );
  assert(
    directVariableDeclarators(program, 'sentryRequestIsolationReady').length ===
      1,
    `${filePath} must not reinitialize application request isolation owners`
  );
  const mutations = mutatedNames(program);
  assert(
    !mutations.has('application'),
    `${filePath} must not mutate application request isolation owners`
  );
  assert(
    !mutations.has('sentryRequestIsolationReady'),
    `${filePath} must not mutate application request isolation owners`
  );
  return declarator;
};

const assertCloudflareSdkOwner = (program, filePath) => {
  const owner = 'Sentry';
  const declarators = topLevelBindingDeclarators(program, owner);
  assert(
    declarators.length === 1 &&
      directVariableDeclarators(program, owner).length === 1,
    `${filePath} must declare the trusted Sentry SDK owner exactly once`
  );
  const [declarator] = declarators;
  assert(
    identifierName(declarator.id) === owner,
    `${filePath} must bind the trusted Sentry SDK namespace directly`
  );
  assert(
    nodeType(declarator.init) === 'AwaitExpression',
    `${filePath} must await the trusted Sentry SDK import`
  );
  const importSource = dynamicImportSource(declarator);
  assert(
    /^\.\/assets\/esm(?:-[\w-]+)?\.js$/.test(importSource ?? ''),
    `${filePath} must initialize the trusted Sentry SDK from its runtime owner`
  );
  const artifactRoot = path.dirname(filePath);
  const chunkFile = path.resolve(artifactRoot, importSource);
  assert(
    isWithinDirectory(chunkFile, artifactRoot),
    `${filePath} must keep the trusted Sentry SDK inside its artifact`
  );
  assertFile(chunkFile);
  const manifestFile = path.join(artifactRoot, '.vite', 'manifest.json');
  assertFile(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const assetFile = importSource.replace(/^\.\//, '');
  const sdkSources = viteManifestEntries(manifest, manifestFile).filter(
    (entry) => entry.file === assetFile
  );
  assert(
    sdkSources.length === 1,
    `${chunkFile} must have one Vite package provenance record`
  );
  assert(
    sdkSources[0].isDynamicEntry === true,
    `${chunkFile} must remain a dynamic Sentry package entry`
  );
  assert(
    /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@sentry\/cloudflare\/build\/esm\/index\.js$/.test(
      sdkSources[0].src
    ),
    `${chunkFile} must originate from @sentry/cloudflare`
  );
  const { program: sdkProgram } = readParsedModule(chunkFile);
  const exports = new Map(
    sdkProgram.body
      .filter(
        (statement) =>
          statement.type === 'ExportNamedDeclaration' && !statement.source
      )
      .flatMap(namedExportEntries)
  );
  const functionEntries = sdkProgram.body.flatMap(topLevelFunctionEntries);
  for (const requiredExport of [
    'setAsyncLocalStorageAsyncContextStrategy',
    'withScope',
    'wrapRequestHandler',
  ]) {
    assert(
      exports.get(requiredExport) === requiredExport,
      `${chunkFile} must export required Sentry SDK owner ${requiredExport}`
    );
    const owners = functionEntries.filter(([name]) => name === requiredExport);
    assert(
      owners.length === 1,
      `${chunkFile} must define required Sentry SDK owner ${requiredExport} exactly once`
    );
    const variableOwners = topLevelBindingDeclarators(
      sdkProgram,
      requiredExport
    );
    const functionOwners = sdkProgram.body.filter(
      (statement) =>
        statement.type === 'FunctionDeclaration' &&
        identifierName(statement.id) === requiredExport
    );
    assert(
      variableOwners.length + functionOwners.length === 1,
      `${chunkFile} must define required Sentry SDK owner ${requiredExport} exactly once`
    );
    assert(
      !mutatedNames(sdkProgram).has(requiredExport),
      `${chunkFile} must not mutate required Sentry SDK owner ${requiredExport}`
    );
  }
  assert(
    !mutatedNames(program).has(owner),
    `${filePath} must not mutate trusted owner ${owner}`
  );
  return declarator;
};

const assertOwnerReferencesStayInRanges = (
  program,
  filePath,
  owner,
  declarator,
  allowedRanges
) => {
  assert(
    !hasIdentifierOutsideRanges(program, owner, [
      [declarator.id.start, declarator.id.end],
      ...allowedRanges,
    ]),
    `${filePath} must not alias trusted owner ${owner}`
  );
};

const assertCloudflareLifecycleChunk = (program, chunkFile) => {
  assertExactStaticChunkHelper(
    program,
    chunkFile,
    'forceFlushRequestTelemetry',
    /^\.\/request-completion(?:-[\w-]+)?\.js$/
  );
  for (const helper of ['getTelemetry', 'reportTelemetryFailure']) {
    assertExactStaticChunkHelper(
      program,
      chunkFile,
      helper,
      /^\.\/telemetry(?:-[\w-]+)?\.js$/
    );
  }
  const owner = topLevelVariableInitializer(
    program,
    'scheduleCloudflareRequestFlush'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression',
    `${chunkFile} must define its Cloudflare request flush owner`
  );
  assert(
    owner.async === false,
    `${chunkFile} must define its Cloudflare request flush owner`
  );
  assert(
    owner.params.map(identifierName).join(':') === 'request:waitUntil',
    `${chunkFile} request flush owner must accept the active request lifecycle`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} request flush owner must own its bounded lifecycle body`
  );
  assert(
    owner.body.body.length === 2,
    `${chunkFile} request flush owner must have one flush and waitUntil scope`
  );
  const flushDeclarators = directBodyVariableDeclarators(owner, 'flush');
  assert(
    flushDeclarators.length === 1,
    `${chunkFile} request flush owner must create one direct flush completion`
  );
  assert(
    flushDeclarators[0].index === 0,
    `${chunkFile} request flush owner must create one direct flush completion`
  );
  assertConditions(
    [
      flushDeclarators[0].declaration.kind === 'const',
      flushDeclarators[0].declaration.declarations.length === 1,
      flushDeclarators[0].declaration.declarations[0] ===
        flushDeclarators[0].declarator,
    ],
    `${chunkFile} request flush owner must isolate one immutable flush completion`
  );
  const flushThen = flushDeclarators[0].declarator.init;
  assert(
    nodeType(flushThen) === 'CallExpression',
    `${chunkFile} request flush owner must bound its flush completion`
  );
  assert(
    flushThen.callee?.computed === false &&
      identifierName(flushThen.callee.property) === 'then',
    `${chunkFile} request flush owner must bound its flush completion`
  );
  assert(
    flushThen.arguments.length === 1,
    `${chunkFile} request flush owner must have one bounded completion mapper`
  );
  const completionMapper = flushThen.arguments[0];
  assert(
    nodeType(completionMapper) === 'ArrowFunctionExpression',
    `${chunkFile} request flush owner must have one bounded completion mapper`
  );
  assertConditions(
    [completionMapper.params.length === 0, completionMapper.expression],
    `${chunkFile} request flush owner must settle after bounded completion`
  );
  assert(
    nodeType(completionMapper.body) === 'UnaryExpression',
    `${chunkFile} request flush owner must settle after bounded completion`
  );
  assertConditions(
    [
      completionMapper.body.operator === 'void',
      completionMapper.body.argument.value === 0,
    ],
    `${chunkFile} request flush owner must settle after bounded completion`
  );
  const forceFlush = flushThen.callee.object;
  assert(
    nodeType(forceFlush) === 'CallExpression',
    `${chunkFile} request flush owner must force-flush request telemetry`
  );
  assert(
    identifierName(forceFlush.callee) === 'forceFlushRequestTelemetry',
    `${chunkFile} request flush owner must force-flush request telemetry`
  );
  assert(
    identifierName(forceFlush.arguments[0]) === 'request',
    `${chunkFile} request flush owner must flush the active request`
  );
  const telemetry = forceFlush.arguments[1];
  assert(
    nodeType(telemetry) === 'CallExpression',
    `${chunkFile} request flush owner must flush the active telemetry adapter`
  );
  assert(
    identifierName(telemetry.callee) === 'getTelemetry',
    `${chunkFile} request flush owner must flush the active telemetry adapter`
  );
  assert(
    telemetry.arguments.length === 0,
    `${chunkFile} request flush owner must flush the active telemetry adapter`
  );
  const lifecycle = owner.body.body[1];
  assertConditions(
    [lifecycle.type === 'TryStatement', lifecycle.finalizer === null],
    `${chunkFile} request flush owner must isolate waitUntil failures`
  );
  assert(
    lifecycle.block.body.length === 1,
    `${chunkFile} request flush owner must schedule one waitUntil completion`
  );
  const waitUntilCall = lifecycle.block.body[0].expression;
  assert(
    nodeType(waitUntilCall) === 'CallExpression',
    `${chunkFile} request flush owner must invoke active waitUntil`
  );
  assert(
    identifierName(waitUntilCall.callee) === 'waitUntil',
    `${chunkFile} request flush owner must invoke active waitUntil`
  );
  assert(
    identifierName(waitUntilCall.arguments[0]) === 'flush',
    `${chunkFile} request flush owner must schedule the active flush completion`
  );
  assert(
    nodeType(lifecycle.handler) === 'CatchClause',
    `${chunkFile} request flush owner must classify waitUntil failures`
  );
  assert(
    lifecycle.handler.body.body.length === 1,
    `${chunkFile} request flush owner must not propagate waitUntil failures`
  );
  assert(
    identifierName(lifecycle.handler.param) === 'failure',
    `${chunkFile} request flush owner must classify waitUntil failures`
  );
  const reportCall = lifecycle.handler.body.body[0].expression;
  assert(
    nodeType(reportCall) === 'CallExpression',
    `${chunkFile} request flush owner must report waitUntil failures`
  );
  assert(
    identifierName(reportCall.callee) === 'reportTelemetryFailure',
    `${chunkFile} request flush owner must report waitUntil failures`
  );
  assertConditions(
    [
      literalString(reportCall.arguments[0]) === 'otel.cloudflare.wait_until',
      identifierName(reportCall.arguments[1]) === 'failure',
    ],
    `${chunkFile} request flush owner must report bounded waitUntil diagnostics`
  );
};

const assertCloudflareDatabaseClose = (program, chunkFile) => {
  assertExactLocalChunkFunction(program, chunkFile, 'closeDatabase');
  assertExactStaticChunkHelper(
    program,
    chunkFile,
    'reportTelemetryFailure',
    /^\.\/telemetry(?:-[\w-]+)?\.js$/
  );
  const owner = topLevelVariableInitializer(program, 'closeDatabase');
  assertConditions(
    [
      nodeType(owner) === 'ArrowFunctionExpression',
      owner.async,
      owner.params.map(identifierName).join(':') === 'database',
    ],
    `${chunkFile} database close owner must accept one active client`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} database close owner must own a bounded close body`
  );
  assertConditions(
    [owner.body.body.length === 1, owner.body.body[0].type === 'TryStatement'],
    `${chunkFile} database close owner must isolate one bounded close attempt`
  );
  const closeScope = owner.body.body[0];
  assertConditions(
    [closeScope.finalizer === null, closeScope.block.body.length === 1],
    `${chunkFile} database close owner must isolate one bounded close attempt`
  );
  const close = closeScope.block.body[0].expression;
  assertConditions(
    [
      nodeType(close) === 'AwaitExpression',
      identifierMemberSignature(close.argument?.callee) ===
        'MemberExpression:false:database:$close',
      close.argument?.arguments.length === 0,
    ],
    `${chunkFile} database close owner must await the active client`
  );
  const handler = closeScope.handler;
  assertConditions(
    [
      nodeType(handler) === 'CatchClause',
      identifierName(handler?.param) === 'failure',
      handler?.body.body.length === 1,
    ],
    `${chunkFile} database close owner must isolate close failures`
  );
  const report = handler.body.body[0].expression;
  assertConditions(
    [
      nodeType(report) === 'CallExpression',
      identifierName(report.callee) === 'reportTelemetryFailure',
      report.arguments.length === 2,
      literalString(report.arguments[0]) === 'database.cloudflare.close',
      identifierName(report.arguments[1]) === 'failure',
    ],
    `${chunkFile} database close owner must report bounded close diagnostics`
  );
};

const assertCloudflareDatabaseBodyGuards = (statements, chunkFile) => {
  const bodyGuard = statements[0];
  assert(
    nodeType(bodyGuard) === 'IfStatement',
    `${chunkFile} database response owner must close bodyless responses`
  );
  assert(
    nodeType(bodyGuard.test) === 'UnaryExpression',
    `${chunkFile} database response owner must close bodyless responses`
  );
  assert(
    nodeType(bodyGuard.consequent) === 'BlockStatement',
    `${chunkFile} database response owner must close bodyless responses`
  );
  assertConditions(
    [
      bodyGuard.alternate === null,
      bodyGuard.test.operator === '!',
      identifierMemberSignature(bodyGuard.test.argument) ===
        'MemberExpression:false:response:body',
      bodyGuard.consequent.body.length === 2,
    ],
    `${chunkFile} database response owner must close bodyless responses`
  );
  const close = bodyGuard.consequent.body[0].expression;
  const bodyReturn = bodyGuard.consequent.body[1];
  assertConditions(
    [
      nodeType(close) === 'CallExpression',
      identifierName(close.callee) === 'closeDatabase',
      close.arguments.length === 1,
      identifierName(close.arguments[0]) === 'database',
      nodeType(bodyReturn) === 'ReturnStatement',
      identifierName(bodyReturn.argument) === 'response',
    ],
    `${chunkFile} database response owner must close bodyless responses`
  );
  const lockedGuard = statements[1];
  assert(
    nodeType(lockedGuard) === 'IfStatement',
    `${chunkFile} database response owner must reject used or locked bodies`
  );
  assert(
    nodeType(lockedGuard.test) === 'LogicalExpression',
    `${chunkFile} database response owner must reject used or locked bodies`
  );
  assert(
    nodeType(lockedGuard.consequent) === 'ThrowStatement',
    `${chunkFile} database response owner must reject used or locked bodies`
  );
  const lockedFailure = lockedGuard.consequent.argument;
  assert(
    nodeType(lockedFailure) === 'NewExpression',
    `${chunkFile} database response owner must reject used or locked bodies`
  );
  assertConditions(
    [
      lockedGuard.alternate === null,
      lockedGuard.test.operator === '||',
      identifierMemberSignature(lockedGuard.test.left) ===
        'MemberExpression:false:response:bodyUsed',
      identifierName(lockedGuard.test.right?.property) === 'locked',
      identifierMemberSignature(lockedGuard.test.right?.object) ===
        'MemberExpression:false:response:body',
      identifierName(lockedFailure.callee) === 'TypeError',
      lockedFailure.arguments.length === 1,
      typeof literalString(lockedFailure.arguments[0]) === 'string',
    ],
    `${chunkFile} database response owner must reject used or locked bodies`
  );
};

const assertCloudflareDatabaseCompletion = (thenCall, chunkFile) => {
  assert(
    nodeType(thenCall) === 'CallExpression',
    `${chunkFile} database response owner must close after stream completion`
  );
  assert(
    nodeType(thenCall.callee) === 'MemberExpression',
    `${chunkFile} database response owner must close after stream completion`
  );
  assertConditions(
    [
      thenCall.callee.computed === false,
      identifierName(thenCall.callee.property) === 'then',
      thenCall.arguments.length === 1,
    ],
    `${chunkFile} database response owner must close after stream completion`
  );
  const closeCallback = thenCall.arguments[0];
  assertConditions(
    [
      nodeType(closeCallback) === 'ArrowFunctionExpression',
      closeCallback.params.length === 0,
      identifierName(closeCallback.body?.callee) === 'closeDatabase',
      closeCallback.body?.arguments.length === 1,
      identifierName(closeCallback.body?.arguments[0]) === 'database',
    ],
    `${chunkFile} database response owner must close after stream completion`
  );
  return thenCall.callee.object;
};

const assertCloudflareDatabaseProducerIsolation = (catchCall, chunkFile) => {
  assert(
    nodeType(catchCall) === 'CallExpression',
    `${chunkFile} database response owner must isolate producer termination`
  );
  assert(
    nodeType(catchCall.callee) === 'MemberExpression',
    `${chunkFile} database response owner must isolate producer termination`
  );
  assertConditions(
    [
      catchCall.callee.computed === false,
      identifierName(catchCall.callee.property) === 'catch',
      catchCall.arguments.length === 1,
      nodeType(catchCall.arguments[0]) === 'ArrowFunctionExpression',
      catchCall.arguments[0].params.length === 0,
      nodeType(catchCall.arguments[0].body) === 'UnaryExpression',
      catchCall.arguments[0].body.operator === 'void',
      catchCall.arguments[0].body.argument?.value === 0,
    ],
    `${chunkFile} database response owner must isolate producer termination`
  );
  return catchCall.callee.object;
};

const assertCloudflareDatabasePipe = (pipeCall, chunkFile) => {
  assert(
    nodeType(pipeCall) === 'CallExpression',
    `${chunkFile} database response owner must pipe the active body`
  );
  assert(
    nodeType(pipeCall.callee) === 'MemberExpression',
    `${chunkFile} database response owner must pipe the active body`
  );
  assertConditions(
    [
      pipeCall.callee.computed === false,
      identifierName(pipeCall.callee.property) === 'pipeTo',
      identifierMemberSignature(pipeCall.callee.object) ===
        'MemberExpression:false:response:body',
      pipeCall.arguments.length === 2,
      identifierName(pipeCall.arguments[0]) === 'writable',
    ],
    `${chunkFile} database response owner must pipe the active body`
  );
  const pipeOptions = ownerProperties(
    pipeCall.arguments[1],
    chunkFile,
    'the Cloudflare response pipeline'
  );
  assertConditions(
    [
      pipeOptions.size === 1,
      identifierMemberSignature(pipeOptions.get('signal')) ===
        'MemberExpression:false:request:signal',
    ],
    `${chunkFile} database response owner must use the active abort signal`
  );
};

const assertCloudflareDatabasePipeline = (statement, chunkFile) => {
  assert(
    nodeType(statement) === 'ExpressionStatement',
    `${chunkFile} database response owner must close after stream completion`
  );
  const catchCall = assertCloudflareDatabaseCompletion(
    statement.expression,
    chunkFile
  );
  const pipeCall = assertCloudflareDatabaseProducerIsolation(
    catchCall,
    chunkFile
  );
  assertCloudflareDatabasePipe(pipeCall, chunkFile);
};

const inertTopLevelArray = (node) =>
  node.elements.every(
    (element) => element === null || isInertTopLevelInitializer(element)
  );

const inertTopLevelObjectProperty = (property) =>
  [
    property.type === 'Property',
    property.computed === false,
    property.kind === 'init',
    property.method === false,
    isInertTopLevelInitializer(property.value),
  ].every(Boolean);

const inertTopLevelObject = (node) =>
  node.properties.every(inertTopLevelObjectProperty);

const inertTopLevelPair = (node) =>
  isInertTopLevelInitializer(node.left) &&
  isInertTopLevelInitializer(node.right);

const inertTopLevelConditional = (node) =>
  [node.test, node.consequent, node.alternate].every(
    isInertTopLevelInitializer
  );

const inertTopLevelConstructors = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const inertTopLevelMapEntry = (node) =>
  nodeType(node) === 'ArrayExpression' &&
  node.elements.length === 2 &&
  node.elements.every(
    (element) => element !== null && isInertTopLevelInitializer(element)
  );

const inertTopLevelMapEntries = (node) =>
  nodeType(node) === 'ArrayExpression' &&
  node.elements.every(
    (element) => element !== null && inertTopLevelMapEntry(element)
  );

const inertTopLevelSetValues = (node) =>
  nodeType(node) === 'ArrayExpression' &&
  node.elements.every(
    (element) => element !== null && isInertTopLevelInitializer(element)
  );

const inertCollectionArguments = {
  Map: (arguments_) =>
    arguments_.length === 0 ||
    (arguments_.length === 1 && inertTopLevelMapEntries(arguments_[0])),
  Set: (arguments_) =>
    arguments_.length === 0 ||
    (arguments_.length === 1 && inertTopLevelSetValues(arguments_[0])),
  WeakMap: (arguments_) => arguments_.length === 0,
  WeakSet: (arguments_) => arguments_.length === 0,
};

const inertTopLevelNew = (node) =>
  Boolean(
    inertCollectionArguments[identifierName(node.callee)]?.(node.arguments)
  );

const inertTopLevelReaders = {
  ArrayExpression: inertTopLevelArray,
  ArrowFunctionExpression: () => true,
  ConditionalExpression: inertTopLevelConditional,
  FunctionExpression: () => true,
  Literal: () => true,
  LogicalExpression: inertTopLevelPair,
  NewExpression: inertTopLevelNew,
  ObjectExpression: inertTopLevelObject,
};

const isInertTopLevelInitializer = (node) =>
  node === null || Boolean(inertTopLevelReaders[nodeType(node)]?.(node));

const isAllowedTopLevelInitializer = (declarator, allowedInitializers) =>
  isInertTopLevelInitializer(declarator.init) ||
  Boolean(
    allowedInitializers[identifierName(declarator.id)]?.(declarator.init)
  );

const inertTopLevelVariableStatement = (statement, allowedInitializers) =>
  statement.declarations.every((declarator) =>
    isAllowedTopLevelInitializer(declarator, allowedInitializers)
  );

const inertTopLevelExportStatement = (statement) =>
  [statement.declaration === null, statement.source === null].every(Boolean);

const inertTopLevelStatementReaders = {
  ExportNamedDeclaration: inertTopLevelExportStatement,
  FunctionDeclaration: () => true,
  ImportDeclaration: () => true,
  VariableDeclaration: inertTopLevelVariableStatement,
};

const isInertTopLevelStatement = (statement, allowedInitializers) =>
  Boolean(
    inertTopLevelStatementReaders[statement.type]?.(
      statement,
      allowedInitializers
    )
  );

const normalizeArtifactFile = (artifactRoot, filePath) =>
  path.relative(artifactRoot, filePath).split(path.sep).join('/');

const isSafeRelativeArtifactFile = (file) =>
  typeof file === 'string' &&
  file.length > 0 &&
  !file.startsWith('/') &&
  !file.includes('\\') &&
  !file.split('/').includes('..');

const manifestFilesForKeys = (manifestRecord, keys, message) =>
  keys.map((key) => {
    const file = manifestRecord.manifest[key]?.file;
    assert(typeof file === 'string', message);
    return file;
  });

const exactSortedValues = (left, right) =>
  left.length === right.length &&
  left.toSorted().join('\0') === right.toSorted().join('\0');

const cloudflareLoadEffectCalls = new Set(['Function', 'eval', 'fetch']);
const cloudflareLoadEffectConstructors = new Set([
  'EventSource',
  'Function',
  'Proxy',
  'WebSocket',
  'Worker',
  'XMLHttpRequest',
]);
const isCloudflareObjectPropertyDefinition = (target, bindings) => {
  const resolved = cloudflareCallableTarget(target, bindings);
  return (
    nodeType(resolved) === 'MemberExpression' &&
    identifierName(resolved.object) === 'Object' &&
    cloudflareMemberName(resolved) === 'defineProperty'
  );
};

const isCloudflareStaticValueDescriptor = ({ target }) =>
  nodeType(target) === 'ObjectExpression' &&
  target.properties.every(
    (property) =>
      nodeType(property) !== 'SpreadElement' &&
      !new Set(['get', 'set']).has(property.kind) &&
      !new Set(['get', 'set']).has(propertyKeyName(property))
  );

const cloudflarePropertyDescriptorsAreSafe = (descriptors) =>
  descriptors.length > 0 &&
  descriptors.every(isCloudflareStaticValueDescriptor);

const isCloudflareUnsafePropertyDefinitionAt = (
  execution,
  target,
  lexicalContext
) => {
  if (
    !isCloudflareObjectPropertyDefinition(
      target,
      lexicalContext.topLevelBindings
    )
  ) {
    return false;
  }
  const descriptor = execution.arguments?.[2];
  if (!descriptor) return true;
  const descriptors = cloudflareLexicalTargetCandidates(
    execution,
    descriptor,
    lexicalContext
  );
  return !cloudflarePropertyDescriptorsAreSafe(descriptors);
};

const cloudflareFunctionNodeTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);
const isCloudflareFunctionNode = (node) =>
  cloudflareFunctionNodeTypes.has(nodeType(node));
const isCloudflareClassNode = (node) =>
  new Set(['ClassDeclaration', 'ClassExpression']).has(nodeType(node));

const cloudflareFunctionNodes = (program) => {
  const functions = [];
  const record = (node) => functions.push(node);
  new Visitor({
    ArrowFunctionExpression: record,
    FunctionDeclaration: record,
    FunctionExpression: record,
  }).visit(program);
  return functions;
};

const cloudflareExecutionReaders = {
  AwaitExpression: (node) => node.argument,
  ChainExpression: (node) => node.expression,
  ParenthesizedExpression: (node) => node.expression,
  SequenceExpression: (node) => node.expressions.at(-1),
};

const unwrapCloudflareExecutionTarget = (node) => {
  const unwrapped = cloudflareExecutionReaders[nodeType(node)]?.(node);
  return unwrapped ? unwrapCloudflareExecutionTarget(unwrapped) : node;
};

const cloudflareLiteralMemberValue = (property) => {
  const value = cloudflareStaticValue(property);
  return value === unknownCloudflareStaticValue ? undefined : value;
};

const isCloudflareMemberName = (value) =>
  new Set(['bigint', 'number', 'string']).has(typeof value);

const cloudflareLiteralMemberName = (property) => {
  const value = cloudflareLiteralMemberValue(property);
  if (typeof value === 'bigint') return value.toString();
  return isCloudflareMemberName(value) ? value : undefined;
};

const cloudflareMemberName = (node) => {
  if (nodeType(node) !== 'MemberExpression') return undefined;
  return node.computed
    ? cloudflareLiteralMemberName(node.property)
    : identifierName(node.property);
};

const cloudflareWildcardMemberProjection = Object.freeze({
  wildcardMember: true,
});

const cloudflareOpaqueArraySpreadProjection = Object.freeze({
  opaqueArraySpread: true,
});

const isCloudflareWildcardMemberProjection = (member) =>
  member?.wildcardMember === true;

const isCloudflareOpaqueArraySpreadProjection = (member) =>
  member?.opaqueArraySpread === true;

const cloudflareProjectionMemberName = (node) => {
  if (nodeType(node) !== 'MemberExpression') return undefined;
  const member = cloudflareMemberName(node);
  return member ?? cloudflareWildcardMemberProjection;
};

const cloudflareFunctionBindingEntries = (statement) =>
  statement.id ? [[statement.id.name, statement]] : [];

const cloudflareVariableBindingEntry = (declarator) => {
  if (!declarator.init) return [];
  return bindingNames(declarator.id).flatMap((name) => {
    const values = cloudflarePatternBindingValues(
      declarator.id,
      declarator.init,
      name
    );
    return values.length === 1 ? [[name, values[0]]] : [];
  });
};

const cloudflareVariableBindingEntries = (statement) =>
  statement.declarations.flatMap(cloudflareVariableBindingEntry);

const cloudflareExportBindingEntries = (statement) =>
  statement.declaration ? cloudflareBindingEntries(statement.declaration) : [];

const cloudflareBindingEntryReaders = {
  ClassDeclaration: cloudflareFunctionBindingEntries,
  ExportDefaultDeclaration: cloudflareExportBindingEntries,
  ExportNamedDeclaration: cloudflareExportBindingEntries,
  FunctionDeclaration: cloudflareFunctionBindingEntries,
  VariableDeclaration: cloudflareVariableBindingEntries,
};

const cloudflareBindingEntries = (statement) => {
  const readEntries = cloudflareBindingEntryReaders[statement.type];
  return readEntries ? readEntries(statement) : [];
};

const cloudflareTopLevelBindings = (program) =>
  new Map(program.body.flatMap(cloudflareBindingEntries));

const cloudflareArrayMember = (target, object) => {
  const rawIndex =
    nodeType(target.property) === 'Literal'
      ? target.property.value
      : cloudflareMemberName(target);
  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0
    ? object.elements[index]
    : undefined;
};

const cloudflareObjectMember = (target, object, bindings) => {
  const member = cloudflareMemberName(target);
  return object.properties.findLast(
    (candidate) => propertyKeyName(candidate, bindings) === member
  )?.value;
};

const isCloudflareObjectCreateCall = (call) =>
  [
    nodeType(call) === 'CallExpression',
    nodeType(call?.callee) === 'MemberExpression',
    identifierName(call?.callee?.object) === 'Object',
    cloudflareMemberName(call?.callee) === 'create',
  ].every(Boolean);

const cloudflareObjectCreatePrototype = (call) => {
  const prototype = call?.arguments?.[0];
  return isCloudflareObjectCreateCall(call) &&
    nodeType(prototype) === 'ObjectExpression'
    ? prototype
    : undefined;
};

const cloudflareCreatedObjectMember = (target, call) => {
  const prototype = cloudflareObjectCreatePrototype(call);
  return prototype ? cloudflareObjectMember(target, prototype) : undefined;
};

const resolveCloudflareIdentifierTarget = (target, bindings, seen, depth) => {
  const name = identifierName(target);
  if (!bindings.has(name) || seen.has(name)) return target;
  return resolveCloudflareTarget(
    bindings.get(name),
    bindings,
    new Set(seen).add(name),
    depth + 1
  );
};

const resolvedCloudflareMember = (target, object, bindings) => {
  const readMember = {
    ArrayExpression: cloudflareArrayMember,
    CallExpression: cloudflareCreatedObjectMember,
    ObjectExpression: cloudflareObjectMember,
  }[nodeType(object)];
  return readMember ? readMember(target, object, bindings) : undefined;
};

const resolveCloudflareMemberProperty = (target, bindings, seen, depth) => {
  if (!target.computed || cloudflareMemberName(target) !== undefined) {
    return target;
  }
  const property = resolveCloudflareTarget(
    target.property,
    bindings,
    seen,
    depth + 1
  );
  const member = cloudflareLiteralMemberName(property);
  return member === undefined
    ? target
    : { ...target, property: { type: 'Literal', value: member } };
};

const resolveCloudflareMemberTarget = (target, bindings, seen, depth) => {
  const object = resolveCloudflareTarget(
    target.object,
    bindings,
    seen,
    depth + 1
  );
  const normalizedTarget = resolveCloudflareMemberProperty(
    target,
    bindings,
    seen,
    depth
  );
  const member = resolvedCloudflareMember(normalizedTarget, object, bindings);
  return member
    ? resolveCloudflareTarget(member, bindings, seen, depth + 1)
    : { ...normalizedTarget, object };
};

const resolveCloudflareCallTarget = (target, bindings, seen, depth) => {
  const isBoundCall =
    nodeType(target.callee) === 'MemberExpression' &&
    cloudflareMemberName(target.callee) === 'bind';
  return isBoundCall
    ? resolveCloudflareTarget(target.callee.object, bindings, seen, depth + 1)
    : target;
};

const cloudflareTargetReaders = {
  CallExpression: resolveCloudflareCallTarget,
  Identifier: resolveCloudflareIdentifierTarget,
  MemberExpression: resolveCloudflareMemberTarget,
};

const resolveCloudflareTarget = (
  node,
  bindings,
  seen = new Set(),
  depth = 0
) => {
  assert(
    depth <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  const target = unwrapCloudflareExecutionTarget(node);
  const readTarget = cloudflareTargetReaders[nodeType(target)];
  return readTarget ? readTarget(target, bindings, seen, depth) : target;
};

const cloudflareCallableTarget = (node, bindings) => {
  const target = resolveCloudflareTarget(node, bindings);
  if (
    nodeType(target) === 'MemberExpression' &&
    new Set(['apply', 'call']).has(cloudflareMemberName(target))
  ) {
    return resolveCloudflareTarget(target.object, bindings);
  }
  return target;
};

const cloudflareOpaqueApplyArgumentsMessage =
  'Cloudflare load-effect analysis requires statically analyzable Function.prototype.apply arguments';
const cloudflareOpaqueSpreadArgumentsMessage =
  'Cloudflare load-effect analysis requires statically analyzable spread arguments';
const cloudflareOpaqueAggregateSpreadMessage =
  'Cloudflare load-effect analysis requires statically analyzable aggregate spreads';
const cloudflareAggregateAccessorMessage =
  'Cloudflare load-effect analysis rejects accessor properties in aggregate spreads';
const cloudflareAccessorAmbiguityMessage =
  'Cloudflare load-effect analysis rejects ambiguous getter/setter ownership';
const cloudflareOpaqueComputedCallableDefinitionMessage =
  'Cloudflare load-effect analysis requires statically analyzable computed callable definitions';
const cloudflareOpaqueComputedCallableInvocationMessage =
  'Cloudflare load-effect analysis requires statically analyzable computed callable invocations';
const cloudflareFactoryResolutionLimit = 32;
const cloudflareFactoryResolutionMessage =
  'Cloudflare load-effect analysis exceeded bounded factory resolution';
const cloudflareParameterProjectionDepthLimit = 16;
const cloudflareParameterProjectionCountLimit = 512;
const cloudflareParameterProjectionDepthMessage =
  'Cloudflare load-effect analysis exceeded bounded parameter projection depth';
const cloudflareParameterProjectionCountMessage =
  'Cloudflare load-effect analysis exceeded bounded parameter projection count';
const cloudflareTargetResolutionWorkLimit = 65_536;
const cloudflareTargetResolutionDepthLimit = 32;
const cloudflareTargetResolutionWorkMessage =
  'Cloudflare load-effect analysis exceeded bounded target candidate resolution';
const cloudflareAnalysisWorkLimit = 65_536;
const cloudflareAnalysisWorkMessage =
  'Cloudflare load-effect analysis exceeded bounded candidate work';

const cloudflareStaticArrayCandidates = (node, source, lexicalContext) => {
  const candidates = lexicalContext
    ? cloudflareLexicalTargetCandidates(node, source, lexicalContext)
    : [{ target: source }];
  return candidates.length > 0 &&
    candidates.every(({ target }) => nodeType(target) === 'ArrayExpression')
    ? candidates.map(({ target }) => target)
    : undefined;
};

const cloudflareExpandedArgument = (node, argument, lexicalContext) => {
  if (nodeType(argument) !== 'SpreadElement') return [argument];
  const arrays = cloudflareStaticArrayCandidates(
    node,
    argument.argument,
    lexicalContext
  );
  return arrays ? arrays.flatMap(({ elements }) => elements) : [argument];
};

const cloudflareExpandedArguments = (node, arguments_, lexicalContext) =>
  arguments_.flatMap((argument) =>
    cloudflareExpandedArgument(node, argument, lexicalContext)
  );

const cloudflareApplyExecutionArguments = (
  node,
  arguments_,
  lexicalContext
) => {
  const applied = arguments_[1];
  const arrays = cloudflareStaticArrayCandidates(node, applied, lexicalContext);
  assert(arrays, cloudflareOpaqueApplyArgumentsMessage);
  return arrays.flatMap(({ elements }) => elements);
};

const cloudflareCallArgumentReaders = {
  apply: cloudflareApplyExecutionArguments,
  call: (_node, arguments_) => arguments_.slice(1),
};

const cloudflareCallExecutionArguments = (
  node,
  arguments_,
  invocation,
  lexicalContext
) => {
  const readArguments =
    cloudflareCallArgumentReaders[invocation?.invocationKind];
  return readArguments
    ? readArguments(node, arguments_, lexicalContext)
    : arguments_;
};

const cloudflareTaggedExecutionArguments = (node) => [
  node.quasi,
  ...node.quasi.expressions,
];

const cloudflareBoundExecutionArguments = (invocation) =>
  Array.isArray(invocation?.boundArguments) ? invocation.boundArguments : [];

const cloudflareExecutionArguments = (node, invocation, lexicalContext) => {
  if (nodeType(node) === 'TaggedTemplateExpression') {
    return cloudflareTaggedExecutionArguments(node);
  }
  const arguments_ = Array.isArray(node.arguments) ? node.arguments : [];
  const callArguments =
    nodeType(node) === 'CallExpression'
      ? cloudflareCallExecutionArguments(
          node,
          arguments_,
          invocation,
          lexicalContext
        )
      : arguments_;
  return cloudflareExpandedArguments(
    node,
    [...cloudflareBoundExecutionArguments(invocation), ...callArguments],
    lexicalContext
  );
};

const createCloudflareLexicalContext = (program, analysisLabel) => ({
  analysisWork: 0,
  analysisLabel,
  accessorAccessKinds: new WeakMap(),
  executionsByOwner: undefined,
  directCallSitesByOwner: undefined,
  executionOwnersByNode: new WeakMap(),
  executionOwnersInProgress: new WeakSet(),
  factoryBindingKeysByFunction: new WeakMap(),
  factoryBindingEpoch: 0,
  factoryBindingRevisionByFunction: new WeakMap(),
  factoryBindingsByFunction: new WeakMap(),
  factoryResolutionDepth: 0,
  functionOwners: new WeakMap(),
  invokedFunctionDependencies: new WeakMap(),
  invokedParameterSummaryState: undefined,
  invocationEdgesByCallee: undefined,
  invocationEdgesEpoch: -1,
  invocationEdgesInProgress: false,
  lexicalBindingsByNode: new WeakMap(),
  lexicalEntriesByScope: new WeakMap(),
  memberMutationIndex: undefined,
  memberAccessesByOwner: undefined,
  parentNodes: createAstParentMap(program),
  nodesByRange: createAstNodeRangeMap(program),
  patternAccessesByOwner: undefined,
  program,
  receiverIdentityIndex: undefined,
  targetResolutionDepth: 0,
  targetResolutionRoot: undefined,
  targetResolutionStack: [],
  targetResolutionWork: 0,
  topLevelBindings: cloudflareTopLevelBindings(program),
});

const createAstNodeRangeMap = (root) => {
  const nodes = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Number.isInteger(node?.start) && Number.isInteger(node?.end)) {
      nodes.set(`${String(node.start)}:${String(node.end)}`, node);
    }
    astVisitorChildren(node).forEach((child) => pending.push(child));
  }
  return nodes;
};

const cloudflareOptionalSource = (source) => (source ? [source] : []);

const cloudflareIteratorValueTarget = (source) => ({
  ...cloudflareProjectionMember(
    {
      arguments: [],
      callee: cloudflareProjectionMember(source, 'next'),
      type: 'CallExpression',
    },
    'value'
  ),
  cloudflareIteratorSource: source,
});

const cloudflareObjectPatternExpressionSource = (source, property) => {
  const key = propertyKeyName(property);
  return key === undefined
    ? cloudflareOptionalSource(source)
    : [cloudflareProjectionMember(source, key)];
};

const cloudflareObjectPatternLiteralSource = (source, property) => {
  const key = propertyKeyName(property);
  const matching = source.properties.findLast(
    (candidate) => propertyKeyName(candidate) === key
  );
  return new Set(['get', 'set']).has(matching?.kind)
    ? [cloudflareProjectionMember(source, key)]
    : cloudflareOptionalSource(matching?.value);
};

const cloudflareObjectPatternSource = (source, property) => (
  assert(
    property.computed !== true || propertyKeyName(property) !== undefined,
    'Cloudflare load-effect analysis requires static destructuring keys'
  ),
  nodeType(source) === 'ObjectExpression'
    ? cloudflareObjectPatternLiteralSource(source, property)
    : cloudflareObjectPatternExpressionSource(source, property)
);

const cloudflareArrayPatternSource = (source, index, element) => {
  if (nodeType(source) !== 'ArrayExpression') {
    return cloudflareOptionalSource(cloudflareIteratorValueTarget(source));
  }
  return nodeType(element) === 'RestElement'
    ? [{ ...source, elements: source.elements.slice(index) }]
    : cloudflareOptionalSource(source.elements[index]);
};

const cloudflareObjectRestSource = (pattern, source, restProperty) => {
  if (nodeType(source) !== 'ObjectExpression') {
    return cloudflareOptionalSource(source);
  }
  const excludedKeys = new Set(
    pattern.properties
      .filter((property) => property !== restProperty)
      .map(propertyKeyName)
  );
  assert(
    source.properties.every(
      (property) => !new Set(['get', 'set']).has(property.kind)
    ),
    cloudflareAggregateAccessorMessage
  );
  return [
    {
      ...source,
      properties: source.properties.filter(
        (property) => !excludedKeys.has(propertyKeyName(property))
      ),
    },
  ];
};

const cloudflareObjectPatternPropertySource = (pattern, source, property) =>
  nodeType(property) === 'RestElement'
    ? cloudflareObjectRestSource(pattern, source, property)
    : cloudflareObjectPatternSource(source, property);

const noCloudflarePatternBindingValues = () => [];

const cloudflareIdentifierBindingValues = (pattern, source, name) =>
  pattern.name === name ? [source] : [];

const cloudflareUndefinedExpressionSignatures = new Set([
  'UnaryExpression:void',
]);

const cloudflareUndefinedExpressionSignature = (source) =>
  `${nodeType(source)}:${source?.name ?? source?.operator}`;

const cloudflareStaticallyUndefined = (source, node, context) => {
  if (source === undefined) return true;
  if (
    identifierName(source) === 'undefined' &&
    context &&
    !artifactOwnerLexicalBinding(node, 'undefined', context)
  ) {
    return true;
  }
  return cloudflareUndefinedExpressionSignatures.has(
    cloudflareUndefinedExpressionSignature(source)
  );
};

const cloudflareAssignmentDefaultValues = (pattern, name, node, context) => {
  if (!bindingNames(pattern.left).includes(name)) return [];
  return nodeType(pattern.left) === 'Identifier'
    ? [pattern.right]
    : cloudflarePatternBindingValuesUnchecked(
        pattern.left,
        pattern.right,
        name,
        node,
        context
      );
};

const cloudflareAssignmentBindingValues = (
  pattern,
  source,
  name,
  node,
  context
) => {
  if (cloudflareStaticallyUndefined(source, node, context)) {
    return cloudflareAssignmentDefaultValues(pattern, name, node, context);
  }
  const projected = cloudflarePatternBindingValuesUnchecked(
    pattern.left,
    source,
    name,
    node,
    context
  );
  if (projected.length > 0) return projected;
  return cloudflareAssignmentDefaultValues(pattern, name, node, context);
};

const cloudflareRestBindingValues = (pattern, source, name, node, context) =>
  cloudflarePatternBindingValuesUnchecked(
    pattern.argument,
    source,
    name,
    node,
    context
  );

const cloudflareArrayBindingValues = (pattern, source, name, node, context) =>
  pattern.elements.flatMap((element, index) => {
    if (!bindingNames(element).includes(name)) return [];
    return cloudflarePatternBindingValuesUnchecked(
      element,
      cloudflareArrayPatternSource(source, index, element)[0],
      name,
      node,
      context
    );
  });

const cloudflareObjectBindingValues = (pattern, source, name, node, context) =>
  pattern.properties.flatMap((property) => {
    const target = property.value ?? property.argument;
    if (!bindingNames(target).includes(name)) return [];
    return cloudflarePatternBindingValuesUnchecked(
      target,
      cloudflareObjectPatternPropertySource(pattern, source, property)[0],
      name,
      node,
      context
    );
  });

const cloudflarePatternBindingReaders = {
  ArrayPattern: cloudflareArrayBindingValues,
  AssignmentPattern: cloudflareAssignmentBindingValues,
  Identifier: cloudflareIdentifierBindingValues,
  ObjectPattern: cloudflareObjectBindingValues,
  RestElement: cloudflareRestBindingValues,
};

function cloudflarePatternBindingValuesUnchecked(
  pattern,
  source,
  name,
  node,
  context
) {
  const reader =
    cloudflarePatternBindingReaders[nodeType(pattern)] ??
    noCloudflarePatternBindingValues;
  return reader(pattern, source, name, node, context);
}

function cloudflarePatternBindingValues(pattern, source, name, node, context) {
  assertArtifactPatternBound(pattern);
  return cloudflarePatternBindingValuesUnchecked(
    pattern,
    source,
    name,
    node,
    context
  );
}

const cloudflareParameterBinding = (binding) =>
  artifactOwnerFunctionScopeTypes.has(nodeType(binding.scope)) &&
  binding.scope.params.includes(binding.digestNode);

const cloudflareBindingValueMutations = (binding, name, context) =>
  artifactOwnerLexicalMutations(binding, name, context).filter(
    ({ node }) => nodeType(node.left) !== 'MemberExpression'
  );

const cloudflareLexicalBindingValues = (binding, name, context) => {
  if (cloudflareParameterBinding(binding)) return [];
  if (nodeType(binding.scope) === 'ForOfStatement') {
    return artifactOwnerLexicalValueNodes(binding, name, context).map(
      cloudflareIteratorValueTarget
    );
  }
  if (
    nodeType(binding.digestNode) === 'VariableDeclarator' &&
    nodeType(binding.scope) !== 'ForOfStatement'
  ) {
    return [
      ...cloudflarePatternBindingValues(
        binding.digestNode.id,
        binding.digestNode.init,
        name,
        binding.digestNode,
        context
      ),
      ...cloudflareBindingValueMutations(binding, name, context).flatMap(
        ({ node, values }) =>
          values.flatMap((value) =>
            cloudflarePatternBindingValues(
              node.left,
              value,
              name,
              node,
              context
            )
          )
      ),
    ];
  }
  return artifactOwnerLexicalValueNodes(binding, name, context);
};

const cloudflareBoundIdentifierCandidates = (
  node,
  target,
  context,
  seen,
  binding
) => {
  if (cloudflareParameterBinding(binding)) {
    return [{ parameterName: target.name, parameterPath: [], target }];
  }
  if (seen.has(binding.digestNode)) return [];
  const nextSeen = new Set(seen).add(binding.digestNode);
  if (
    nodeType(binding.digestNode) === 'VariableDeclarator' &&
    nodeType(binding.scope) !== 'ForOfStatement'
  ) {
    const sources = [
      {
        anchor: binding.digestNode,
        pattern: binding.digestNode.id,
        source: binding.digestNode.init,
      },
      ...cloudflareBindingValueMutations(binding, target.name, context).flatMap(
        ({ node: mutation, values }) =>
          values.map((value) => ({
            anchor: mutation,
            pattern: mutation.left,
            source: value,
          }))
      ),
    ];
    return sources.flatMap(({ anchor, pattern, source }) =>
      cloudflareLexicalTargetCandidates(
        anchor,
        source,
        context,
        nextSeen
      ).flatMap((sourceCandidate) =>
        cloudflareProjectedPatternCandidates(
          node,
          { name: target.name, parameter: pattern },
          sourceCandidate,
          [],
          context
        )
      )
    );
  }
  return cloudflareLexicalBindingValues(binding, target.name, context).flatMap(
    (value) => cloudflareLexicalTargetCandidates(node, value, context, nextSeen)
  );
};

const cloudflareIdentifierTargetCandidates = (node, target, context, seen) => {
  const binding = artifactOwnerLexicalBinding(node, target.name, context);
  const captured = cloudflareCapturedIdentifierCandidates(
    node,
    target,
    context,
    binding
  );
  if (captured) return captured;
  return binding
    ? cloudflareBoundIdentifierCandidates(node, target, context, seen, binding)
    : cloudflareTopLevelIdentifierCandidates(node, target, context, seen);
};

const cloudflareTopLevelIdentifierCandidates = (
  node,
  target,
  context,
  seen
) => {
  const resolved = resolveCloudflareTarget(
    target,
    context.topLevelBindings,
    seen
  );
  return resolved === target
    ? [{ target }]
    : cloudflareLexicalTargetCandidates(node, resolved, context, seen);
};

const cloudflareCapturedIdentifierCandidates = (
  node,
  target,
  context,
  binding
) => {
  if (!binding || !cloudflareParameterBinding(binding)) return undefined;
  const owner = cloudflareFunctionOwnerAt(node, context);
  if (owner === binding.scope) return undefined;
  return context.factoryBindingsByFunction.get(owner)?.get(target.name);
};

const cloudflareRequiresComputedMemberResolution = (target) =>
  target.computed && cloudflareMemberName(target) === undefined;

const allCloudflareMemberNamesKnown = (members) =>
  members.length > 0 && members.every((member) => member !== undefined);

const cloudflareStaticComputedMemberTargets = (node, target, context, seen) => {
  if (!cloudflareRequiresComputedMemberResolution(target)) return [target];
  const propertyCandidates = cloudflareLexicalTargetCandidates(
    node,
    target.property,
    context,
    seen
  );
  const members = propertyCandidates.map(({ target: property }) =>
    cloudflareLiteralMemberName(unwrapCloudflareExecutionTarget(property))
  );
  if (allCloudflareMemberNamesKnown(members)) {
    return members.map((member) => ({
      ...target,
      property: { type: 'Literal', value: member },
    }));
  }
  return [{ ...target, cloudflareWildcardMember: true }];
};

const cloudflareWildcardMemberValues = (target) => {
  if (nodeType(target) === 'ArrayExpression') {
    return target.elements.filter(Boolean);
  }
  if (nodeType(target) === 'ObjectExpression') {
    return target.properties.flatMap((property) =>
      property.value ? [property.value] : []
    );
  }
  return undefined;
};

const cloudflareMemberProjection = (memberTarget) =>
  memberTarget.cloudflareWildcardMember
    ? cloudflareWildcardMemberProjection
    : cloudflareProjectionMemberName(memberTarget);

const cloudflareWildcardMemberCandidates = (node, candidate, context, seen) => {
  const values = cloudflareWildcardMemberValues(candidate.target);
  return values
    ? values.flatMap((value) =>
        inheritCloudflareCandidateContexts(
          candidate,
          cloudflareLexicalTargetCandidates(node, value, context, seen)
        )
      )
    : undefined;
};

const cloudflareProjectedParameterCandidate = (candidate, memberProjection) => [
  {
    ...candidate,
    parameterPath: [...(candidate.parameterPath ?? []), memberProjection],
  },
];

const cloudflareUnresolvedMemberCandidate = (candidate, memberTarget) => [
  {
    target: {
      ...memberTarget,
      cloudflareWildcardMember: memberTarget.cloudflareWildcardMember === true,
      ...(candidate.target?.cloudflareOpaqueIteratorElement
        ? { cloudflareOpaqueIteratorElement: true }
        : {}),
      ...(candidate.target?.cloudflareOpaqueSpreadElement
        ? {
            cloudflareOpaqueSpreadElement: true,
            cloudflareSafeOpaqueSpreadIteration:
              candidate.target.cloudflareSafeOpaqueSpreadIteration === true,
          }
        : {}),
      object: candidate.target,
    },
  },
];

const cloudflareInheritedAccessorOwners = (parent, child, factoryBindings) =>
  [...(parent.accessorOwners ?? []), ...(child.accessorOwners ?? [])].map(
    (owner) =>
      factoryBindings && !owner.factoryBindings
        ? { ...owner, factoryBindings }
        : owner
  );

const inheritCloudflareCandidateContext = (parent, child) => {
  const parentBindings = parent.factoryBindings;
  const childBindings = child.factoryBindings;
  const inheritedChildBindings = childBindings
    ? new Map(
        [...childBindings].map(([name, candidates]) => [
          name,
          candidates.flatMap((candidate) =>
            candidate.parameterName &&
            parentBindings?.has(candidate.parameterName)
              ? parentBindings.get(candidate.parameterName)
              : [candidate]
          ),
        ])
      )
    : undefined;
  const factoryBindings =
    parentBindings || inheritedChildBindings
      ? new Map([
          ...(parentBindings?.entries() ?? []),
          ...(inheritedChildBindings?.entries() ?? []),
        ])
      : undefined;
  const accessorOwners = cloudflareInheritedAccessorOwners(
    parent,
    child,
    factoryBindings
  );
  return {
    ...child,
    ...(parent.boundArguments && !child.boundArguments
      ? { boundArguments: parent.boundArguments }
      : {}),
    ...(parent.boundThisValue && !child.boundThisValue
      ? { boundThisValue: parent.boundThisValue }
      : {}),
    ...(factoryBindings ? { factoryBindings } : {}),
    ...(parent.invocationKind && !child.invocationKind
      ? { invocationKind: parent.invocationKind }
      : {}),
    ...(parent.safeFalsyShortCircuit === true
      ? { safeFalsyShortCircuit: true }
      : {}),
    ...(accessorOwners.length > 0 ? { accessorOwners } : {}),
  };
};

const inheritCloudflareCandidateContexts = (parent, children) =>
  children.flatMap((child) => {
    const captured = child.parameterName
      ? parent.factoryBindings?.get(child.parameterName)
      : undefined;
    return captured
      ? captured.map((candidate) =>
          inheritCloudflareCandidateContext(parent, candidate)
        )
      : [inheritCloudflareCandidateContext(parent, child)];
  });

const cloudflareKnownWildcardMemberCandidates = (
  node,
  candidate,
  memberProjection,
  context,
  seen
) =>
  isCloudflareWildcardMemberProjection(memberProjection)
    ? cloudflareWildcardMemberCandidates(node, candidate, context, seen)
    : undefined;

const firstDefinedCloudflareCandidateGroup = (readers) =>
  readers.map((read) => read()).find((candidates) => candidates !== undefined);

const cloudflareDirectProxyHandlerCandidates = (node, proxy, context, seen) =>
  isCloudflareDirectProxyConstruction(proxy, context)
    ? cloudflareLexicalTargetCandidates(
        node,
        proxy.arguments?.[1],
        context,
        seen
      ).filter(({ target }) => nodeType(target) === 'ObjectExpression')
    : [];

const cloudflareProxyGetTrapCandidates = (
  node,
  _memberTarget,
  candidate,
  context,
  seen
) => {
  const handlers = cloudflareDirectProxyHandlerCandidates(
    node,
    candidate.target,
    context,
    seen
  );
  if (handlers.length === 0) return undefined;
  const traps = handlers.flatMap(({ target: handler }) =>
    handler.properties
      .filter((property) => propertyKeyName(property) === 'get')
      .map(({ value }) => value)
      .filter(isCloudflareFunctionNode)
  );
  if (traps.length === 0) return undefined;
  return inheritCloudflareCandidateContexts(
    candidate,
    traps.flatMap((trap) =>
      cloudflareAccessorReturnCandidates({ value: trap }, context, seen)
    )
  );
};

const cloudflareObjectCreateMemberCandidates = (
  node,
  memberTarget,
  candidate,
  context,
  seen
) => {
  const call = candidate.target;
  if (!isCloudflareObjectCreateCall(call)) return undefined;
  assert(!seen.has(call), cloudflareFactoryResolutionMessage);
  const nextSeen = new Set(seen).add(call);
  const prototype = call.arguments[0];
  if (!prototype) return [];
  return inheritCloudflareCandidateContexts(
    candidate,
    cloudflareLexicalTargetCandidates(
      node,
      prototype,
      context,
      nextSeen
    ).flatMap((prototypeCandidate) =>
      cloudflareMemberCandidate(
        node,
        memberTarget,
        prototypeCandidate,
        context,
        nextSeen
      )
    )
  );
};

const cloudflareResolvedMemberCandidates = (
  node,
  memberTarget,
  candidate,
  memberProjection,
  context,
  seen
) => {
  const specialMembers = firstDefinedCloudflareCandidateGroup([
    () =>
      cloudflareObjectCreateMemberCandidates(
        node,
        memberTarget,
        candidate,
        context,
        seen
      ),
    () =>
      cloudflareProxyGetTrapCandidates(
        node,
        memberTarget,
        candidate,
        context,
        seen
      ),
    () =>
      cloudflareGeneratorMemberCandidates(
        node,
        memberTarget,
        candidate,
        context,
        seen
      ),
    () =>
      cloudflareClassMemberTargetCandidates(
        node,
        memberTarget,
        candidate,
        context,
        seen
      ),
    () =>
      cloudflareObjectAccessorCandidates(
        memberTarget,
        candidate.target,
        context,
        seen
      ),
  ]);
  if (specialMembers) {
    return inheritCloudflareCandidateContexts(candidate, specialMembers);
  }
  const object = cloudflareObjectForMemberResolution(candidate.target);
  if (object) {
    assertCloudflareComputedCallableDefinitions(object.properties, context);
  }
  const memberName = cloudflareMemberName(memberTarget);
  const member =
    object && memberName !== undefined
      ? object.properties.findLast(
          (property) =>
            cloudflareLexicalPropertyKeyName(property, context) === memberName
        )?.value
      : resolvedCloudflareMember(
          memberTarget,
          candidate.target,
          context.topLevelBindings
        );
  if (member) {
    return inheritCloudflareCandidateContexts(
      candidate,
      cloudflareLexicalTargetCandidates(member, member, context, seen)
    );
  }
  return candidate.parameterName
    ? cloudflareProjectedParameterCandidate(candidate, memberProjection)
    : cloudflareUnresolvedMemberCandidate(candidate, memberTarget);
};

const cloudflareGeneratorFlowExpressions = (generator) => {
  const yields = [];
  const returns = [];
  const nestedRanges = nestedFunctionRanges(generator);
  new Visitor({
    ReturnStatement(returnStatement) {
      if (isInsideNestedFunction(returnStatement, nestedRanges)) return;
      if (returnStatement.argument) returns.push(returnStatement.argument);
    },
    YieldExpression(yieldExpression) {
      if (isInsideNestedFunction(yieldExpression, nestedRanges)) return;
      if (yieldExpression.argument) yields.push(yieldExpression);
    },
  }).visit(generator.body);
  return { returns, yields };
};

const cloudflareDelegatedGeneratorExpressions = (expression, context, seen) =>
  cloudflareLexicalTargetCandidates(
    expression,
    expression,
    context,
    seen
  ).flatMap(({ target }) => {
    if (nodeType(target) === 'ArrayExpression') {
      return target.elements.filter(Boolean);
    }
    if (nodeType(target) !== 'CallExpression') return [target];
    return cloudflareLexicalTargetCandidates(
      target,
      target.callee,
      context,
      seen
    )
      .map(({ target: owner }) => owner)
      .filter((owner) => isCloudflareFunctionNode(owner) && owner.generator)
      .flatMap((owner) =>
        cloudflareGeneratorResultExpressions(owner, context, seen)
      );
  });

function cloudflareGeneratorResultExpressions(generator, context, seen) {
  assert(!seen.has(generator), cloudflareFactoryResolutionMessage);
  const nextSeen = new Set(seen).add(generator);
  const { returns, yields } = cloudflareGeneratorFlowExpressions(generator);
  const flow = [...yields, ...returns];
  return flow.flatMap((expression) => {
    if (nodeType(expression) !== 'YieldExpression') return [expression];
    return expression.delegate
      ? cloudflareDelegatedGeneratorExpressions(
          expression.argument,
          context,
          nextSeen
        )
      : [expression.argument];
  });
}

const cloudflareAccessorReturnCandidates = (accessor, context, seen) => {
  assert(!seen.has(accessor.value), cloudflareFactoryResolutionMessage);
  const nextSeen = new Set(seen).add(accessor.value);
  const owner = { target: accessor.value };
  const returned = cloudflareFunctionReturnExpressions(accessor.value).flatMap(
    (expression) =>
      cloudflareLexicalTargetCandidates(
        expression,
        expression,
        context,
        nextSeen
      ).map((candidate) => ({
        ...candidate,
        accessorOwners: [owner],
      }))
  );
  return returned.length > 0
    ? returned
    : [
        {
          accessorOwners: [owner],
          target: { name: 'undefined', type: 'Identifier' },
        },
      ];
};

const cloudflareAccessorKindsForAccess = (accessKind) =>
  accessKind === 'get-set' ? new Set(['get', 'set']) : new Set([accessKind]);

const cloudflareSetterCandidates = (setter) => [
  {
    accessorOwners: [{ target: setter.value }],
    target: { name: 'undefined', type: 'Identifier' },
  },
];

const cloudflareAccessorCandidates = (
  members,
  context,
  seen,
  accessKind = 'get'
) => {
  const accessors = members.filter(({ kind }) =>
    new Set(['get', 'set']).has(kind)
  );
  if (accessors.length === 0) return undefined;
  const selected = accessors.filter(({ kind }) =>
    cloudflareAccessorKindsForAccess(accessKind).has(kind)
  );
  if (selected.length === 0) return [];
  assert(
    new Set(selected.map(({ kind }) => kind)).size === selected.length,
    cloudflareAccessorAmbiguityMessage
  );
  return selected.flatMap((accessor) =>
    accessor.kind === 'get'
      ? cloudflareAccessorReturnCandidates(accessor, context, seen)
      : cloudflareSetterCandidates(accessor)
  );
};

const cloudflareObjectForMemberResolution = (target) => {
  if (nodeType(target) === 'ObjectExpression') return target;
  return cloudflareObjectCreatePrototype(target);
};

const cloudflareObjectAccessorCandidates = (
  memberTarget,
  target,
  context,
  seen
) => {
  const object = cloudflareObjectForMemberResolution(target);
  const member = cloudflareMemberName(memberTarget);
  if (!object || member === undefined) return undefined;
  assertCloudflareComputedCallableDefinitions(object.properties, context);
  const members = object.properties.filter(
    (property) => cloudflareLexicalPropertyKeyName(property, context) === member
  );
  return cloudflareAccessorCandidates(
    members,
    context,
    seen,
    context.accessorAccessKinds.get(memberTarget)
  );
};

const cloudflareGeneratorNextReceiver = (candidate) => {
  const nextCall = candidate.target;
  if (nodeType(nextCall) !== 'CallExpression') return undefined;
  const nextMember = nextCall.callee;
  if (nodeType(nextMember) !== 'MemberExpression') return undefined;
  return cloudflareMemberName(nextMember) === 'next'
    ? nextMember.object
    : undefined;
};

const cloudflareGeneratorCallsForValue = (
  node,
  memberTarget,
  candidate,
  context,
  seen
) => {
  if (cloudflareMemberName(memberTarget) !== 'value') return [];
  const receiver = cloudflareGeneratorNextReceiver(candidate);
  if (!receiver) return [];
  return cloudflareLexicalTargetCandidates(node, receiver, context, seen)
    .map(({ target }) => target)
    .filter((target) => nodeType(target) === 'CallExpression');
};

const cloudflareGeneratorMemberCandidates = (
  node,
  memberTarget,
  candidate,
  context,
  seen
) => {
  const generatorCalls = cloudflareGeneratorCallsForValue(
    node,
    memberTarget,
    candidate,
    context,
    seen
  );
  if (generatorCalls.length === 0) return undefined;
  const candidates = generatorCalls.flatMap((generatorCall) =>
    cloudflareLexicalTargetCandidates(node, generatorCall.callee, context, seen)
      .filter(
        ({ target }) => isCloudflareFunctionNode(target) && target.generator
      )
      .flatMap((owner) => {
        const bindings = cloudflareFactoryParameterBindings(
          generatorCall,
          owner,
          context
        );
        return cloudflareGeneratorResultExpressions(
          owner.target,
          context,
          seen
        ).flatMap((yielded) =>
          cloudflareLexicalTargetCandidates(
            yielded,
            yielded,
            context,
            seen
          ).map((yieldedCandidate) =>
            cloudflareCandidateWithFactoryBindings(yieldedCandidate, bindings)
          )
        );
      })
  );
  return nonEmptyCloudflareCandidates(candidates);
};

const cloudflareMemberCandidate = (
  node,
  memberTarget,
  candidate,
  context,
  seen
) => {
  const memberProjection = cloudflareMemberProjection(memberTarget);
  return (
    cloudflareKnownWildcardMemberCandidates(
      node,
      candidate,
      memberProjection,
      context,
      seen
    ) ??
    cloudflareResolvedMemberCandidates(
      node,
      memberTarget,
      candidate,
      memberProjection,
      context,
      seen
    )
  );
};

const cloudflareIteratorValueCandidates = (node, target, context, seen) => {
  if (!target.cloudflareIteratorSource) return undefined;
  const sources = cloudflareLexicalTargetCandidates(
    node,
    target.cloudflareIteratorSource,
    context,
    seen
  );
  if (
    sources.some((candidate) =>
      new Set(['CallExpression', 'NewExpression']).has(
        nodeType(candidate.target)
      )
    )
  ) {
    return undefined;
  }
  return sources.flatMap((candidate) => {
    if (candidate.parameterName) {
      return cloudflareProjectedParameterCandidate(
        candidate,
        cloudflareWildcardMemberProjection
      );
    }
    return nodeType(candidate.target) === 'ArrayExpression'
      ? candidate.target.elements
          .filter(Boolean)
          .flatMap((value) =>
            inheritCloudflareCandidateContexts(
              candidate,
              cloudflareSourceCandidates(node, value, context)
            )
          )
      : [
          {
            ...candidate,
            target: {
              ...candidate.target,
              cloudflareOpaqueIteratorElement: true,
            },
          },
        ];
  });
};

const cloudflareMemberTargetCandidates = (node, target, context, seen) => {
  const iteratorValues = cloudflareIteratorValueCandidates(
    node,
    target,
    context,
    seen
  );
  if (iteratorValues) return iteratorValues;
  if (target.cloudflareSymbolicParameterName) {
    return [
      {
        parameterName: target.cloudflareSymbolicParameterName,
        parameterPath: [
          ...(target.cloudflareSymbolicParameterPath ?? []),
          target.cloudflareSymbolicArraySpread
            ? cloudflareOpaqueArraySpreadProjection
            : cloudflareWildcardMemberProjection,
        ],
        target: target.object,
      },
    ];
  }
  const thisMethodCandidates = cloudflareThisMethodCandidates(
    node,
    target,
    context
  );
  if (thisMethodCandidates) return thisMethodCandidates;
  const normalizedTargets = cloudflareStaticComputedMemberTargets(
    node,
    target,
    context,
    seen
  );
  return normalizedTargets.flatMap((normalizedTarget) =>
    cloudflareNormalizedMemberTargetCandidates(
      node,
      normalizedTarget,
      context,
      seen
    )
  );
};

const cloudflareThisMethodCandidates = (node, target, context) => {
  if (nodeType(target.object) !== 'ThisExpression') return undefined;
  const classNode = findCloudflareEnclosingClass(node, context);
  const member = cloudflareMemberName(target);
  if (!classNode) return undefined;
  if (member === undefined) return undefined;
  const candidates = cloudflareClassMemberCandidates(
    node,
    classNode,
    member,
    false,
    context,
    new Set()
  );
  return nonEmptyCloudflareCandidates(candidates);
};

const nonEmptyCloudflareCandidates = (candidates) =>
  candidates.length > 0 ? candidates : undefined;

const cloudflareClassMemberValue = (element) =>
  new Set(['MethodDefinition', 'PropertyDefinition']).has(nodeType(element))
    ? element.value
    : undefined;

const cloudflareLexicalPropertyKeyName = (property, context) => {
  const direct = propertyKeyName(property);
  if (direct !== undefined || property?.computed !== true) return direct;
  const directValues =
    nodeType(property.key) === 'Identifier'
      ? cloudflareDirectLocalBindingValues(property.key, property.key, context)
      : [];
  const candidates =
    directValues.length > 0
      ? directValues.map((target) => ({ target }))
      : cloudflareLexicalTargetCandidates(
          property.key,
          property.key,
          context,
          new Set()
        );
  const members = new Set(
    candidates
      .map(({ target }) => cloudflareLiteralMemberName(target))
      .filter((member) => member !== undefined)
  );
  return members.size === 1 ? [...members][0] : undefined;
};

const assertCloudflareComputedCallableDefinitions = (properties, context) => {
  assert(
    !properties.some(
      (property) =>
        property.computed === true &&
        cloudflareLexicalPropertyKeyName(property, context) === undefined
    ),
    `${cloudflareOpaqueComputedCallableDefinitionMessage} in ${context.analysisLabel}`
  );
};

const cloudflareOwnClassMembers = (
  classNode,
  member,
  staticMember,
  context
) => {
  const members = classNode.body.body.filter(
    (element) => element.static === staticMember
  );
  assertCloudflareComputedCallableDefinitions(members, context);
  return members.filter(
    (element) => cloudflareLexicalPropertyKeyName(element, context) === member
  );
};

const cloudflareOwnClassMemberCandidates = (
  ownMembers,
  context,
  seen,
  accessKind
) => {
  const accessorCandidates = cloudflareAccessorCandidates(
    ownMembers,
    context,
    seen,
    accessKind
  );
  if (accessorCandidates) return accessorCandidates;
  const ownValue = cloudflareClassMemberValue(ownMembers.at(-1));
  return ownValue
    ? cloudflareLexicalTargetCandidates(ownValue, ownValue, context, seen)
    : undefined;
};

function cloudflareClassMemberCandidates(
  _node,
  classNode,
  member,
  staticMember,
  context,
  seen,
  accessKind = 'get'
) {
  const pending = [{ classNode, depth: 0 }];
  const visited = new Set([...seen].filter(isCloudflareClassNode));
  const candidates = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current.classNode)) continue;
    assert(
      current.depth <= cloudflareFactoryResolutionLimit,
      cloudflareFactoryResolutionMessage
    );
    visited.add(current.classNode);
    consumeCloudflareAnalysisWork(context, 1);
    const nextSeen = new Set(seen).add(current.classNode);
    const ownMembers = cloudflareOwnClassMembers(
      current.classNode,
      member,
      staticMember,
      context
    );
    const ownCandidates = cloudflareOwnClassMemberCandidates(
      ownMembers,
      context,
      nextSeen,
      accessKind
    );
    if (ownCandidates) {
      candidates.push(...ownCandidates);
      continue;
    }
    if (!current.classNode.superClass) continue;
    const superClasses = cloudflareLexicalTargetCandidates(
      current.classNode.superClass,
      current.classNode.superClass,
      context,
      nextSeen
    )
      .map(({ target }) => target)
      .filter(isCloudflareClassNode);
    consumeCloudflareAnalysisWork(context, superClasses.length);
    superClasses.forEach((superClass) =>
      pending.push({ classNode: superClass, depth: current.depth + 1 })
    );
  }
  return candidates;
}

const cloudflareConstructedClassCandidates = (node, target, context, seen) =>
  nodeType(target) === 'NewExpression'
    ? cloudflareLexicalTargetCandidates(node, target.callee, context, seen)
        .map((candidate) => candidate.target)
        .filter(isCloudflareClassNode)
    : [];

const cloudflareConstructorAssignedMemberValues = (constructor, member) => {
  const values = [];
  const nestedRanges = nestedFunctionRanges(constructor);
  new Visitor({
    AssignmentExpression(assignment) {
      if (isInsideNestedFunction(assignment, nestedRanges)) return;
      const target = assignment.left;
      const assignedToMember = [
        nodeType(target) === 'MemberExpression',
        nodeType(target?.object) === 'ThisExpression',
        cloudflareMemberName(target) === member,
      ].every(Boolean);
      if (assignedToMember) {
        values.push(assignment.right);
      }
    },
  }).visit(constructor.body);
  return values;
};

const cloudflareClassTargetsForCandidate = (node, candidate, context, seen) =>
  isCloudflareClassNode(candidate.target)
    ? [{ classNode: candidate.target, staticMember: true }]
    : cloudflareConstructedClassCandidates(
        node,
        candidate.target,
        context,
        seen
      ).map((classNode) => ({ classNode, staticMember: false }));

const cloudflareConstructedAssignedMemberCandidates = (
  node,
  target,
  member,
  context,
  seen
) => {
  if (nodeType(target) !== 'NewExpression') return [];
  return cloudflareLexicalTargetCandidates(node, target.callee, context, seen)
    .filter(({ target: constructor }) => isCloudflareFunctionNode(constructor))
    .flatMap((owner) => {
      const bindings = cloudflareFactoryParameterBindings(
        target,
        owner,
        context
      );
      return cloudflareConstructorAssignedMemberValues(
        owner.target,
        member
      ).flatMap((value) =>
        cloudflareLexicalTargetCandidates(value, value, context, seen).map(
          (candidate) =>
            cloudflareCandidateWithFactoryBindings(candidate, bindings)
        )
      );
    });
};

function cloudflareClassMemberTargetCandidates(
  node,
  memberTarget,
  candidate,
  context,
  seen
) {
  const member = cloudflareMemberName(memberTarget);
  if (member === undefined) return undefined;
  const classTargets = cloudflareClassTargetsForCandidate(
    node,
    candidate,
    context,
    seen
  );
  const assignedMembers = cloudflareConstructedAssignedMemberCandidates(
    node,
    candidate.target,
    member,
    context,
    seen
  );
  if (classTargets.length === 0 && assignedMembers.length === 0)
    return undefined;
  return [
    ...assignedMembers,
    ...classTargets.flatMap(({ classNode, staticMember }) =>
      cloudflareClassMemberCandidates(
        node,
        classNode,
        member,
        staticMember,
        context,
        seen,
        context.accessorAccessKinds.get(memberTarget)
      )
    ),
  ];
}

const cloudflareAmbientAliasTarget = (
  node,
  target,
  context,
  seen = new Set()
) => {
  const unwrapped = unwrapCloudflareExecutionTarget(target);
  if (!unwrapped || seen.has(unwrapped)) return unwrapped;
  const nextSeen = new Set(seen).add(unwrapped);
  if (nodeType(unwrapped) === 'Identifier') {
    const topLevel = resolveCloudflareTarget(
      unwrapped,
      context.topLevelBindings
    );
    if (topLevel !== unwrapped) {
      return cloudflareAmbientAliasTarget(node, topLevel, context, nextSeen);
    }
    const binding = artifactOwnerLexicalBinding(node, unwrapped.name, context);
    const values = binding
      ? cloudflareLexicalBindingValues(binding, unwrapped.name, context)
      : [];
    return values.length === 1
      ? cloudflareAmbientAliasTarget(node, values[0], context, nextSeen)
      : unwrapped;
  }
  if (nodeType(unwrapped) === 'MemberExpression') {
    const object = cloudflareAmbientAliasTarget(
      node,
      unwrapped.object,
      context,
      nextSeen
    );
    return object === unwrapped.object ? unwrapped : { ...unwrapped, object };
  }
  if (
    nodeType(unwrapped) === 'CallExpression' &&
    isCloudflareBindCall(unwrapped.callee)
  ) {
    return cloudflareAmbientAliasTarget(
      node,
      unwrapped.callee.object,
      context,
      nextSeen
    );
  }
  return unwrapped;
};

const cloudflareUnshadowedObjectAssignArguments = (call, context) => {
  if (nodeType(call) !== 'CallExpression') return undefined;
  const unshadowedObjectAssignTarget = (target) => {
    const resolved = cloudflareAmbientAliasTarget(call, target, context);
    if (
      nodeType(resolved) !== 'MemberExpression' ||
      staticMemberName(resolved) !== 'assign'
    ) {
      return false;
    }
    const object = resolved.object;
    const direct = identifierName(object) === 'Object';
    const global =
      nodeType(object) === 'MemberExpression' &&
      identifierName(object.object) === 'globalThis' &&
      staticMemberName(object) === 'Object';
    if (![direct, global].includes(true)) return false;
    const requiredGlobals = global ? ['Object', 'globalThis'] : ['Object'];
    return requiredGlobals.every(
      (name) =>
        !artifactOwnerLexicalBinding(call, name, context) &&
        !findStaticImport(context.program, name)
    );
  };
  const staticArgumentList = (source) => {
    const candidates = cloudflareStaticArrayCandidates(call, source, context);
    assert(
      candidates?.length === 1 &&
        candidates[0].elements.every((element) => element !== null),
      cloudflareOpaqueApplyArgumentsMessage
    );
    return candidates[0].elements;
  };
  const callee = cloudflareAmbientAliasTarget(call, call.callee, context);
  if (unshadowedObjectAssignTarget(callee)) return call.arguments;
  if (
    nodeType(callee) === 'MemberExpression' &&
    new Set(['apply', 'call']).has(cloudflareMemberName(callee)) &&
    unshadowedObjectAssignTarget(callee.object)
  ) {
    return cloudflareMemberName(callee) === 'call'
      ? call.arguments.slice(1)
      : staticArgumentList(call.arguments[1]);
  }
  const reflectApply =
    nodeType(callee) === 'MemberExpression' &&
    identifierName(callee.object) === 'Reflect' &&
    cloudflareMemberName(callee) === 'apply';
  if (
    reflectApply &&
    !artifactOwnerLexicalBinding(call, 'Reflect', context) &&
    !findStaticImport(context.program, 'Reflect') &&
    unshadowedObjectAssignTarget(call.arguments[0])
  ) {
    return staticArgumentList(call.arguments[2]);
  }
  return undefined;
};

const cloudflareObjectAssignCandidatesAreStatic = (candidates) =>
  candidates.every(
    ({ target }) =>
      nodeType(target) === 'ObjectExpression' &&
      target.properties.every(
        (property) => nodeType(property) !== 'SpreadElement'
      )
  );

const cloudflareObjectAssignMatchingCandidates = (
  node,
  source,
  memberTarget,
  context,
  seen
) => {
  const member = cloudflareMemberName(memberTarget);
  const candidates = cloudflareLexicalTargetCandidates(
    node,
    source,
    context,
    seen
  );
  if (!cloudflareObjectAssignCandidatesAreStatic(candidates)) return [];
  return candidates.flatMap((candidate) => {
    const property = candidate.target.properties.findLast(
      (entry) => cloudflareLexicalPropertyKeyName(entry, context) === member
    );
    return property
      ? inheritCloudflareCandidateContexts(
          candidate,
          cloudflareResolvedMemberCandidates(
            node,
            memberTarget,
            candidate,
            member,
            context,
            seen
          )
        )
      : [];
  });
};

const cloudflareObjectAssignMemberCandidates = (
  node,
  memberTarget,
  context,
  seen
) => {
  const arguments_ = cloudflareUnshadowedObjectAssignArguments(
    memberTarget.object,
    context
  );
  if (!arguments_ || arguments_.length === 0) return undefined;
  const member = cloudflareMemberName(memberTarget);
  if (member === undefined) return [];
  for (const source of arguments_.slice(1).toReversed()) {
    const matching = cloudflareObjectAssignMatchingCandidates(
      node,
      source,
      memberTarget,
      context,
      seen
    );
    if (matching.length > 0) return matching;
  }
  return undefined;
};

const cloudflareOpaqueMemberMutationMessage =
  'Cloudflare load-effect analysis rejects opaque aggregate member mutations';

const cloudflareWildcardMutationMember = '\0*';
const cloudflareOpaqueMutationReceiver = '\0opaque-receiver';

const cloudflareReceiverBindingKey = (node, name, context, state) => {
  const binding = artifactOwnerLexicalBinding(node, name, context);
  if (!binding) return undefined;
  let id = state.bindingIds.get(binding.digestNode);
  if (id === undefined) {
    id = state.nextBindingId;
    state.nextBindingId += 1;
    state.bindingIds.set(binding.digestNode, id);
  }
  const key = `binding:${String(id)}:${name}`;
  if (cloudflareParameterBinding(binding)) state.uncertainIdentities.add(key);
  return key;
};

const cloudflareReceiverValueKey = (target, state) => {
  let id = state.valueIds.get(target);
  if (id === undefined) {
    id = state.nextValueId;
    state.nextValueId += 1;
    state.valueIds.set(target, id);
  }
  return `value:${String(id)}`;
};

const cloudflareReceiverMemberKey = (receiver, member) =>
  `${receiver}\0member:${JSON.stringify(String(member))}`;

const cloudflareReceiverIdentityKey = (node, target, context, state) => {
  const unwrapped = unwrapCloudflareExecutionTarget(target);
  if (nodeType(unwrapped) === 'Identifier') {
    return cloudflareReceiverBindingKey(node, unwrapped.name, context, state);
  }
  const returnedReceiver = cloudflareAmbientReturnedReceiver(
    unwrapped,
    context
  );
  if (returnedReceiver) {
    return cloudflareReceiverIdentityKey(
      node,
      returnedReceiver,
      context,
      state
    );
  }
  if (cloudflareKnownIsolatedReceiverSource(unwrapped)) {
    return cloudflareReceiverValueKey(unwrapped, state);
  }
  if (nodeType(unwrapped) !== 'MemberExpression') return undefined;
  const receiver = cloudflareReceiverIdentityKey(
    node,
    unwrapped.object,
    context,
    state
  );
  const member = cloudflareMemberName(unwrapped);
  return receiver && member !== undefined
    ? cloudflareReceiverMemberKey(receiver, member)
    : undefined;
};

const cloudflareEnsureReceiverIdentity = (graph, identity) => {
  if (identity && !graph.has(identity)) graph.set(identity, new Set());
};

const cloudflareLinkReceiverIdentities = (graph, first, second) => {
  if (!first || !second || first === second) return;
  cloudflareEnsureReceiverIdentity(graph, first);
  cloudflareEnsureReceiverIdentity(graph, second);
  graph.get(first).add(second);
  graph.get(second).add(first);
};

const cloudflareReceiverPathKey = (base, path) => {
  let current = base;
  for (const member of path) {
    if (isCloudflareWildcardMemberProjection(member)) return undefined;
    current = cloudflareReceiverMemberKey(current, member);
  }
  return current;
};

const cloudflareReceiverAliasSources = (source) => {
  const unwrapped = unwrapCloudflareExecutionTarget(source);
  if (nodeType(unwrapped) === 'ConditionalExpression') {
    return [unwrapped.consequent, unwrapped.alternate];
  }
  if (nodeType(unwrapped) === 'LogicalExpression') {
    return [unwrapped.left, unwrapped.right];
  }
  if (nodeType(unwrapped) === 'SequenceExpression') {
    return unwrapped.expressions.slice(-1);
  }
  return [unwrapped];
};

const cloudflareReceiverAliasSourceIdentities = (
  anchor,
  source,
  context,
  state
) => {
  const assignArguments = cloudflareUnshadowedObjectAssignArguments(
    source,
    context
  );
  const returnedReceiver = cloudflareAmbientReturnedReceiver(source, context);
  const sources = assignArguments
    ? assignArguments.slice(0, 1)
    : returnedReceiver
      ? [returnedReceiver]
      : cloudflareReceiverAliasSources(source);
  return sources.flatMap((candidate) => {
    const nested = cloudflareReceiverAliasSources(candidate);
    return nested.flatMap((value) =>
      cloudflareOptionalSource(
        cloudflareReceiverIdentityKey(anchor, value, context, state)
      )
    );
  });
};

const cloudflareKnownIsolatedReceiverSource = (source) => {
  const target = unwrapCloudflareExecutionTarget(source);
  return (
    new Set([
      'ArrayExpression',
      'ClassExpression',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'NewExpression',
      'ObjectExpression',
    ]).has(nodeType(target)) || isCloudflareObjectCreateCall(target)
  );
};

const cloudflareReceiverContainerChildren = (target) => {
  if (nodeType(target) === 'ArrayExpression') {
    return target.elements.flatMap((value, index) =>
      value ? [{ member: index, value }] : []
    );
  }
  if (nodeType(target) !== 'ObjectExpression') return [];
  return target.properties.flatMap((property) => {
    if (nodeType(property) === 'SpreadElement') return [];
    const member = propertyKeyName(property);
    return member === undefined || !property.value
      ? []
      : [{ member, value: property.value }];
  });
};

const cloudflareReceiverSourceHasOpaqueContainer = (source, context) => {
  const target = unwrapCloudflareExecutionTarget(source);
  if (
    new Set(['ArrayExpression', 'ObjectExpression']).has(nodeType(target)) &&
    (target.elements ?? target.properties).some(
      (entry) => nodeType(entry) === 'SpreadElement'
    )
  ) {
    return true;
  }
  const assignArguments = cloudflareUnshadowedObjectAssignArguments(
    target,
    context
  );
  return (assignArguments?.length ?? 0) > 1;
};

const cloudflareReceiverProjectionIsOpaque = (path) =>
  path?.some(
    (member) =>
      isCloudflareWildcardMemberProjection(member) ||
      Number.isInteger(member?.restOffset) ||
      Array.isArray(member?.objectRest)
  ) === true;

const cloudflarePatternHasDynamicComputedKey = (pattern) => {
  const pending = [pattern];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      nodeType(current) === 'Property' &&
      current.computed === true &&
      propertyKeyName(current) === undefined
    ) {
      return true;
    }
    astVisitorChildren(current).forEach((child) => pending.push(child));
  }
  return false;
};

const cloudflareRecordReceiverContainerAliases = (
  anchor,
  base,
  target,
  context,
  state
) => {
  const pending = [{ base, depth: 0, target }];
  let work = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    assert(
      current.depth <= cloudflareParameterProjectionDepthLimit,
      cloudflareParameterProjectionDepthMessage
    );
    const children = cloudflareReceiverContainerChildren(current.target);
    work += children.length;
    assert(work <= cloudflareAnalysisWorkLimit, cloudflareAnalysisWorkMessage);
    children.toReversed().forEach(({ member, value }) => {
      const child = cloudflareReceiverMemberKey(current.base, member);
      cloudflareEnsureReceiverIdentity(state.graph, child);
      const valueIdentity = cloudflareReceiverIdentityKey(
        anchor,
        value,
        context,
        state
      );
      cloudflareLinkReceiverIdentities(state.graph, child, valueIdentity);
      if (cloudflareReceiverContainerChildren(value).length > 0) {
        pending.push({
          base: child,
          depth: current.depth + 1,
          target: value,
        });
      }
    });
  }
};

const cloudflareRecordReceiverPatternAliases = (
  anchor,
  pattern,
  source,
  context,
  state
) => {
  const sourceIdentities = cloudflareReceiverAliasSourceIdentities(
    anchor,
    source,
    context,
    state
  );
  bindingNames(pattern).forEach((name) => {
    const bindingIdentity = cloudflareReceiverBindingKey(
      anchor,
      name,
      context,
      state
    );
    const path = cloudflarePatternHasDynamicComputedKey(pattern)
      ? undefined
      : cloudflarePatternBindingPath(pattern, name);
    const projectedSources = path
      ? sourceIdentities.flatMap((sourceIdentity) =>
          cloudflareOptionalSource(
            cloudflareReceiverPathKey(sourceIdentity, path)
          )
        )
      : [];
    const unwrappedSource = unwrapCloudflareExecutionTarget(source);
    const recursiveDynamicSource =
      bindingIdentity &&
      nodeType(unwrappedSource) === 'MemberExpression' &&
      cloudflareMemberName(unwrappedSource) === undefined &&
      cloudflareReceiverIdentityKey(
        anchor,
        unwrappedSource.object,
        context,
        state
      ) === bindingIdentity
        ? [bindingIdentity]
        : [];
    const sourceProjections = [...projectedSources, ...recursiveDynamicSource];
    sourceProjections.forEach((sourceProjection) =>
      cloudflareLinkReceiverIdentities(
        state.graph,
        bindingIdentity,
        sourceProjection
      )
    );
    if (
      bindingIdentity &&
      (cloudflareReceiverProjectionIsOpaque(path) ||
        cloudflareReceiverSourceHasOpaqueContainer(source, context))
    ) {
      state.uncertainIdentities.add(bindingIdentity);
    }
    if (
      bindingIdentity &&
      sourceProjections.length === 0 &&
      !cloudflareKnownIsolatedReceiverSource(source)
    ) {
      state.uncertainIdentities.add(bindingIdentity);
    }
    if (bindingIdentity && nodeType(pattern) === 'Identifier') {
      cloudflareRecordReceiverContainerAliases(
        anchor,
        bindingIdentity,
        source,
        context,
        state
      );
    }
  });
};

const cloudflareReceiverIdentityComponents = (state) => {
  const components = new Map();
  let componentId = 0;
  let work = 0;
  state.graph.forEach((_neighbors, identity) => {
    if (components.has(identity)) return;
    const component = `receiver:${String(componentId)}`;
    componentId += 1;
    const pending = [identity];
    while (pending.length > 0) {
      const current = pending.pop();
      if (components.has(current)) continue;
      components.set(current, component);
      const neighbors = state.graph.get(current) ?? [];
      work += neighbors.size ?? neighbors.length;
      assert(
        work <= cloudflareAnalysisWorkLimit,
        cloudflareAnalysisWorkMessage
      );
      neighbors.forEach((neighbor) => pending.push(neighbor));
    }
  });
  return components;
};

const cloudflareCreateReceiverIdentityIndex = (context) => {
  const state = {
    bindingIds: new WeakMap(),
    graph: new Map(),
    nextBindingId: 0,
    nextValueId: 0,
    uncertainIdentities: new Set(),
    valueIds: new WeakMap(),
  };
  new Visitor({
    AssignmentExpression(node) {
      if (node.operator !== '=') return;
      cloudflareRecordReceiverPatternAliases(
        node,
        node.left,
        node.right,
        context,
        state
      );
    },
    VariableDeclarator(node) {
      if (!node.init) return;
      cloudflareRecordReceiverPatternAliases(
        node,
        node.id,
        node.init,
        context,
        state
      );
    },
  }).visit(context.program);
  const components = cloudflareReceiverIdentityComponents(state);
  const uncertainComponents = new Set(
    [...state.graph.keys()]
      .filter((identity) =>
        [...state.uncertainIdentities].some(
          (uncertain) =>
            identity === uncertain ||
            identity.startsWith(`${uncertain}\0member:`)
        )
      )
      .map((identity) => components.get(identity) ?? identity)
  );
  return { ...state, components, uncertainComponents };
};

const cloudflareReceiverIdentityIndex = (context) => {
  context.receiverIdentityIndex ??=
    cloudflareCreateReceiverIdentityIndex(context);
  return context.receiverIdentityIndex;
};

const cloudflareReceiverDetails = (node, target, context) => {
  const state = cloudflareReceiverIdentityIndex(context);
  const identity = cloudflareReceiverIdentityKey(node, target, context, state);
  if (!identity) return undefined;
  cloudflareEnsureReceiverIdentity(state.graph, identity);
  const component = state.components.get(identity) ?? identity;
  const hasUncertainRoot = [...state.uncertainIdentities].some(
    (uncertain) =>
      identity === uncertain || identity.startsWith(`${uncertain}\0member:`)
  );
  return {
    component,
    uncertain: hasUncertainRoot || state.uncertainComponents.has(component),
  };
};

const cloudflareReceiverComponent = (node, target, context) =>
  cloudflareReceiverDetails(node, target, context)?.component;

const cloudflareExecutionDirectInvocation = (execution) => {
  const target = unwrapCloudflareExecutionTarget(execution.target);
  if (nodeType(target) !== 'MemberExpression') return undefined;
  const invocationKind = cloudflareMemberName(target);
  return new Set(['apply', 'call']).has(invocationKind)
    ? { invocationKind }
    : undefined;
};

const cloudflareDirectCallSitesByOwner = (context) => {
  if (context.directCallSitesByOwner) return context.directCallSitesByOwner;
  const index = new Map();
  cloudflareExecutionIndex(context).forEach((executions) =>
    executions.forEach((execution) =>
      cloudflareDirectExecutionOwners(execution, context).forEach((owner) => {
        const callSites = index.get(owner) ?? [];
        callSites.push(execution);
        index.set(owner, callSites);
      })
    )
  );
  context.directCallSitesByOwner = index;
  return index;
};

const cloudflareDirectCallTargetIdentifier = (target) => {
  const unwrapped = unwrapCloudflareExecutionTarget(target);
  if (nodeType(unwrapped) === 'Identifier') return unwrapped;
  if (
    nodeType(unwrapped) === 'MemberExpression' &&
    new Set(['apply', 'call']).has(cloudflareMemberName(unwrapped))
  ) {
    return identifierName(unwrapCloudflareExecutionTarget(unwrapped.object))
      ? unwrapCloudflareExecutionTarget(unwrapped.object)
      : undefined;
  }
  return undefined;
};

const cloudflareFunctionHasOnlyDirectCallReferences = (
  functionNode,
  context,
  callSites
) => {
  if (nodeType(functionNode) !== 'FunctionDeclaration' || !functionNode.id) {
    return false;
  }
  const name = functionNode.id.name;
  const expectedBinding = artifactOwnerLexicalBinding(
    functionNode,
    name,
    context
  );
  if (!expectedBinding) return false;
  const directIdentifiers = new Set(
    callSites
      .map(({ target }) => cloudflareDirectCallTargetIdentifier(target))
      .filter(Boolean)
  );
  let safe = true;
  new Visitor({
    Identifier(identifier) {
      if (
        safe &&
        cloudflareIdentifierIsIndirectFunctionReference(
          identifier,
          functionNode,
          name,
          expectedBinding,
          directIdentifiers,
          context
        )
      ) {
        safe = false;
      }
    },
  }).visit(context.program);
  return safe;
};

const cloudflareIdentifierIsIndirectFunctionReference = (
  identifier,
  functionNode,
  name,
  expectedBinding,
  directIdentifiers,
  context
) => {
  if (identifier === functionNode.id || identifier.name !== name) return false;
  const binding = artifactOwnerLexicalBinding(identifier, name, context);
  return (
    binding?.digestNode === expectedBinding.digestNode &&
    !directIdentifiers.has(identifier)
  );
};

const cloudflareReceiverParameterProjection = (node, receiver, context) => {
  const path = [];
  let root = unwrapCloudflareExecutionTarget(receiver);
  while (nodeType(root) === 'MemberExpression') {
    const member = cloudflareMemberName(root);
    if (member === undefined) return undefined;
    path.unshift(member);
    root = unwrapCloudflareExecutionTarget(root.object);
  }
  const name = identifierName(root);
  if (!name) return undefined;
  const binding = artifactOwnerLexicalBinding(node, name, context);
  if (!binding || !cloudflareParameterBinding(binding)) return undefined;
  const owner = binding.scope;
  const entry = cloudflareParameterEntries(owner).find(
    (candidate) =>
      candidate.name === name && nodeType(candidate.parameter) === 'Identifier'
  );
  return entry ? { entry, owner, path } : undefined;
};

const cloudflareProjectedReceiverSource = (source, path) =>
  path.reduce(
    (receiver, member) => cloudflareProjectionMember(receiver, member),
    source
  );

const cloudflareReceiverSourceRoot = (source) => {
  let root = unwrapCloudflareExecutionTarget(source);
  while (nodeType(root) === 'MemberExpression') {
    root = unwrapCloudflareExecutionTarget(root.object);
  }
  return root;
};

const cloudflareDirectParameterReceiverSources = (node, receiver, context) => {
  const projection = cloudflareReceiverParameterProjection(
    node,
    receiver,
    context
  );
  if (!projection) return undefined;
  const callSites = cloudflareDirectCallSitesByOwner(context).get(
    projection.owner
  );
  if (
    !callSites ||
    !cloudflareFunctionHasOnlyDirectCallReferences(
      projection.owner,
      context,
      callSites
    )
  ) {
    return undefined;
  }
  const sources = callSites.flatMap((execution) => {
    const arguments_ = cloudflareExecutionArguments(
      execution.node,
      cloudflareExecutionDirectInvocation(execution),
      context
    );
    const source = arguments_[projection.entry.index];
    return source
      ? [cloudflareProjectedReceiverSource(source, projection.path)]
      : [];
  });
  return sources.length > 0 &&
    sources.every(
      (source) =>
        nodeType(cloudflareReceiverSourceRoot(source)) !== 'CallExpression'
    )
    ? sources
    : undefined;
};

const cloudflarePropagateMemberMutationParameter = (
  index,
  node,
  receiver,
  mutation,
  context,
  propagatedParameters
) => {
  const projection = cloudflareReceiverParameterProjection(
    node,
    receiver,
    context
  );
  if (!projection || propagatedParameters.has(projection.owner)) return false;
  const sources = cloudflareDirectParameterReceiverSources(
    node,
    receiver,
    context
  );
  if (!sources) return false;
  const nextPropagated = new Set(propagatedParameters).add(projection.owner);
  sources.forEach((source) =>
    cloudflareRecordMemberMutation(
      index,
      node,
      source,
      mutation,
      context,
      nextPropagated
    )
  );
  return true;
};

const cloudflareStructuralMutationReceiver = (receiver) => {
  if (nodeType(receiver) !== 'MemberExpression') return false;
  const receiverObject = unwrapCloudflareExecutionTarget(receiver.object);
  return new Set([
    'ArrayExpression',
    'CallExpression',
    'ConditionalExpression',
    'LogicalExpression',
    'ObjectExpression',
    'SequenceExpression',
  ]).has(nodeType(receiverObject));
};

const cloudflareResolvedMutationReceivers = (node, receiver, context) => {
  const receiverKey = cloudflareNodeSemanticKey(receiver);
  try {
    return cloudflareLexicalTargetCandidates(node, receiver, context)
      .map(({ target }) => target)
      .filter((target) => cloudflareNodeSemanticKey(target) !== receiverKey);
  } catch (error) {
    fail(
      `Cloudflare load-effect analysis could not resolve a member-mutation receiver in ${context.analysisLabel} (${nodeType(receiver)}@${String(receiver?.start)}:${String(receiver?.end)} from ${nodeType(node)}@${String(node?.start)}:${String(node?.end)}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const cloudflareRecordIndexedMemberMutation = (
  index,
  receiverKey,
  memberKey,
  entry
) => {
  const byMember = index.get(receiverKey) ?? new Map();
  const mutations = byMember.get(memberKey) ?? [];
  mutations.push(entry);
  byMember.set(memberKey, mutations);
  index.set(receiverKey, byMember);
};

const cloudflareRecordMemberMutation = (
  index,
  node,
  receiver,
  mutation,
  context,
  propagatedParameters = new Set()
) => {
  if (
    cloudflarePropagateMemberMutationParameter(
      index,
      node,
      receiver,
      mutation,
      context,
      propagatedParameters
    )
  ) {
    return;
  }
  const receiverDetails = cloudflareReceiverDetails(node, receiver, context);
  const receiverComponent = receiverDetails?.component;
  const unresolvedComputedReceiver =
    nodeType(receiver) === 'MemberExpression' &&
    cloudflareMemberName(receiver) === undefined;
  if (
    receiverComponent === undefined ||
    cloudflareStructuralMutationReceiver(receiver)
  ) {
    const resolvedReceivers = cloudflareResolvedMutationReceivers(
      node,
      receiver,
      context
    );
    if (resolvedReceivers.length > 0) {
      resolvedReceivers.forEach((resolvedReceiver) =>
        cloudflareRecordMemberMutation(
          index,
          node,
          resolvedReceiver,
          mutation,
          context,
          propagatedParameters
        )
      );
      if (!unresolvedComputedReceiver) return;
    }
  }
  const memberKey =
    mutation.member === undefined
      ? cloudflareWildcardMutationMember
      : String(mutation.member);
  const entry = {
    ...mutation,
    node,
    opaque: mutation.opaque === true || receiverComponent === undefined,
    owner: cloudflareFunctionOwnerAt(node, context),
    receiverComponent,
  };
  cloudflareRecordIndexedMemberMutation(
    index,
    receiverComponent ?? cloudflareOpaqueMutationReceiver,
    memberKey,
    entry
  );
  if (receiverDetails?.uncertain) {
    cloudflareRecordIndexedMemberMutation(
      index,
      cloudflareOpaqueMutationReceiver,
      memberKey,
      {
        ...entry,
        opaque: entry.opaque,
        sourceReceiverComponent: receiverComponent,
      }
    );
  }
};

const cloudflareDirectMemberMutation = (node) => {
  if (nodeType(node.left) !== 'MemberExpression') return undefined;
  const receiver = node.left.object;
  const directMember = cloudflareMemberName(node.left);
  const prototypeMutation = directMember === '__proto__';
  const member = prototypeMutation ? undefined : directMember;
  return {
    member,
    opaque: prototypeMutation || node.operator !== '=',
    receiver,
    values: node.operator === '=' ? [node.right] : [],
  };
};

const cloudflareObjectAssignMutation = (node, context) => {
  const ambient = cloudflareNormalizedAmbientMutation(node, context);
  if (ambient?.owner !== 'Object' || ambient.operation !== 'assign') {
    return undefined;
  }
  const arguments_ = ambient.arguments_;
  if (arguments_.length === 0) return undefined;
  return {
    member: undefined,
    receiver: arguments_[0],
    sources: arguments_.slice(1),
  };
};

const cloudflareAmbientStaticArgumentList = (node, source, context) => {
  const candidates = cloudflareStaticArrayCandidates(node, source, context);
  assert(
    candidates?.length === 1 &&
      candidates[0].elements.every((element) => element !== null),
    cloudflareOpaqueApplyArgumentsMessage
  );
  return candidates[0].elements;
};

const cloudflareUnshadowedAmbientOwner = (node, target, context) => {
  const direct = identifierName(target);
  const global =
    nodeType(target) === 'MemberExpression' &&
    identifierName(target.object) === 'globalThis'
      ? cloudflareMemberName(target)
      : undefined;
  const owner = new Set(['Object', 'Reflect']).has(direct) ? direct : global;
  if (!new Set(['Object', 'Reflect']).has(owner)) return undefined;
  const requiredGlobals = global ? ['globalThis', owner] : [owner];
  return requiredGlobals.every(
    (name) =>
      !artifactOwnerLexicalBinding(node, name, context) &&
      !findStaticImport(context.program, name)
  )
    ? owner
    : undefined;
};

const cloudflareAmbientMutationTarget = (node, target, context) => {
  const resolved = cloudflareAmbientAliasTarget(node, target, context);
  if (nodeType(resolved) !== 'MemberExpression') return undefined;
  const operation = cloudflareMemberName(resolved);
  if (new Set(['__defineGetter__', '__defineSetter__']).has(operation)) {
    const receiver =
      nodeType(resolved) === 'MemberExpression'
        ? resolved.object
        : target.object;
    return { operation, owner: 'prototype', receiver };
  }
  const owner = cloudflareUnshadowedAmbientOwner(
    node,
    resolved.object,
    context
  );
  return owner ? { operation, owner } : undefined;
};

const cloudflareSupportedAmbientMutation = (mutation) =>
  mutation?.owner === 'prototype' ||
  (mutation?.owner === 'Object' &&
    new Set([
      'assign',
      'defineProperties',
      'defineProperty',
      'setPrototypeOf',
    ]).has(mutation.operation)) ||
  (mutation?.owner === 'Reflect' &&
    new Set(['defineProperty', 'deleteProperty', 'set', 'setPrototypeOf']).has(
      mutation.operation
    ));

const cloudflareAmbientReflectApply = (node, target, context) =>
  nodeType(target) === 'MemberExpression' &&
  cloudflareUnshadowedAmbientOwner(node, target.object, context) ===
    'Reflect' &&
  cloudflareMemberName(target) === 'apply';

const cloudflarePotentialAmbientMutationTarget = (
  node,
  target,
  context,
  depth = 0
) => {
  if (depth > cloudflareFactoryResolutionLimit) return false;
  const resolved = cloudflareAmbientAliasTarget(node, target, context);
  if (
    cloudflareSupportedAmbientMutation(
      cloudflareAmbientMutationTarget(node, resolved, context)
    ) ||
    cloudflareAmbientReflectApply(node, resolved, context)
  ) {
    return true;
  }
  return (
    nodeType(resolved) === 'MemberExpression' &&
    new Set(['apply', 'call']).has(cloudflareMemberName(resolved)) &&
    cloudflarePotentialAmbientMutationTarget(
      node,
      resolved.object,
      context,
      depth + 1
    )
  );
};

const cloudflareNormalizedAmbientMutation = (node, context) => {
  let target = cloudflareAmbientAliasTarget(node, node.callee, context);
  let arguments_ = node.arguments;
  for (let depth = 0; depth <= cloudflareFactoryResolutionLimit; depth += 1) {
    const mutation = cloudflareAmbientMutationTarget(node, target, context);
    if (cloudflareSupportedAmbientMutation(mutation)) {
      return { ...mutation, arguments_ };
    }
    if (cloudflareAmbientReflectApply(node, target, context)) {
      const nextTarget = cloudflareAmbientAliasTarget(
        node,
        arguments_[0],
        context
      );
      if (
        !cloudflarePotentialAmbientMutationTarget(node, nextTarget, context)
      ) {
        return undefined;
      }
      target = nextTarget;
      arguments_ = cloudflareAmbientStaticArgumentList(
        node,
        arguments_[2],
        context
      );
      continue;
    }
    if (
      nodeType(target) === 'MemberExpression' &&
      new Set(['apply', 'call']).has(cloudflareMemberName(target)) &&
      cloudflarePotentialAmbientMutationTarget(node, target.object, context)
    ) {
      const invocationKind = cloudflareMemberName(target);
      arguments_ =
        invocationKind === 'call'
          ? arguments_.slice(1)
          : cloudflareAmbientStaticArgumentList(node, arguments_[1], context);
      target = cloudflareAmbientAliasTarget(node, target.object, context);
      continue;
    }
    return undefined;
  }
  fail(cloudflareFactoryResolutionMessage);
};

const cloudflareDescriptorMutationValue = (descriptor) =>
  nodeType(descriptor) === 'ObjectExpression'
    ? descriptor.properties.findLast(
        (property) => propertyKeyName(property) === 'value'
      )?.value
    : undefined;

const cloudflareLegacyAmbientMemberMutation = (ambient) => {
  const { arguments_, operation } = ambient;
  if (!new Set(['__defineGetter__', '__defineSetter__']).has(operation)) {
    return undefined;
  }
  return {
    member: cloudflareLiteralMemberName(arguments_[0]),
    opaque: true,
    receiver: ambient.receiver,
    values: [],
  };
};

const cloudflareReflectSetMutation = (ambient) => {
  const { arguments_, operation, owner } = ambient;
  if (operation !== 'set' || owner !== 'Reflect') return undefined;
  const member = cloudflareLiteralMemberName(arguments_[1]);
  return {
    member,
    opaque: member === undefined || arguments_[2] === undefined,
    receiver: arguments_[0],
    values: arguments_[2] === undefined ? [] : [arguments_[2]],
  };
};

const cloudflareStaticDescriptorEntries = (descriptorMap, receiver) => {
  if (nodeType(descriptorMap) !== 'ObjectExpression') return undefined;
  const staticProperties = descriptorMap.properties.every(
    (property) =>
      nodeType(property) !== 'SpreadElement' &&
      property.kind === 'init' &&
      propertyKeyName(property) !== undefined
  );
  if (!staticProperties) return { entries: [], opaque: true };
  const descriptorsByMember = new Map();
  descriptorMap.properties.forEach((property) =>
    descriptorsByMember.set(propertyKeyName(property), property.value)
  );
  return {
    entries: [...descriptorsByMember].map(([member, descriptor]) => ({
      descriptorValues: [descriptor],
      member,
      opaque: false,
      receiver,
      values: [],
    })),
    opaque: false,
  };
};

const cloudflareDefinePropertiesMutation = (ambient) => {
  const { arguments_, operation, owner } = ambient;
  if (operation !== 'defineProperties' || owner !== 'Object') {
    return undefined;
  }
  const receiver = arguments_[0];
  const descriptorSource = arguments_[1];
  const staticDescriptors = cloudflareStaticDescriptorEntries(
    unwrapCloudflareExecutionTarget(descriptorSource),
    receiver
  );
  if (staticDescriptors?.opaque) {
    return { member: undefined, opaque: true, receiver, values: [] };
  }
  if (staticDescriptors) {
    return {
      descriptorEntries: staticDescriptors.entries,
      member: undefined,
      opaque: false,
      receiver,
      values: [],
    };
  }
  return {
    descriptorSources: descriptorSource === undefined ? [] : [descriptorSource],
    member: undefined,
    opaque: descriptorSource === undefined,
    receiver,
    values: [],
  };
};

const cloudflareDefinePropertyMutation = (ambient) => {
  const { arguments_, operation } = ambient;
  const receiver = arguments_[0];
  if (operation !== 'defineProperty') {
    return { member: undefined, opaque: true, receiver, values: [] };
  }
  const member = cloudflareLiteralMemberName(arguments_[1]);
  const value = cloudflareDescriptorMutationValue(arguments_[2]);
  return {
    member,
    opaque: member === undefined || value === undefined,
    receiver,
    values: value === undefined ? [] : [value],
  };
};

const cloudflareAmbientMemberMutation = (node, context) => {
  const ambient = cloudflareNormalizedAmbientMutation(node, context);
  if (!ambient) return undefined;
  const legacy = cloudflareLegacyAmbientMemberMutation(ambient);
  if (legacy) return legacy;
  const { operation } = ambient;
  const supported = new Set([
    'defineProperties',
    'defineProperty',
    'set',
    'setPrototypeOf',
  ]).has(operation);
  if (!supported) return undefined;
  return (
    cloudflareReflectSetMutation(ambient) ??
    cloudflareDefinePropertiesMutation(ambient) ??
    cloudflareDefinePropertyMutation(ambient)
  );
};

const cloudflareAmbientReturnedReceiver = (node, context) => {
  if (nodeType(node) !== 'CallExpression') return undefined;
  const ambient = cloudflareNormalizedAmbientMutation(node, context);
  if (!ambient) return undefined;
  if (
    ambient.owner === 'Object' &&
    new Set(['defineProperties', 'defineProperty', 'setPrototypeOf']).has(
      ambient.operation
    )
  ) {
    return ambient.arguments_[0];
  }
  return undefined;
};

const cloudflareCreateMemberMutationIndex = (context) => {
  const index = new Map();
  context.memberMutationIndex = index;
  new Visitor({
    AssignmentExpression(node) {
      const mutation = cloudflareDirectMemberMutation(node);
      if (!mutation) return;
      cloudflareRecordMemberMutation(
        index,
        node,
        mutation.receiver,
        mutation,
        context
      );
    },
    CallExpression(node) {
      const mutation =
        cloudflareObjectAssignMutation(node, context) ??
        cloudflareAmbientMemberMutation(node, context);
      if (!mutation) return;
      const mutations = mutation.descriptorEntries ?? [mutation];
      mutations.forEach((entry) =>
        cloudflareRecordMemberMutation(
          index,
          node,
          entry.receiver,
          entry,
          context
        )
      );
    },
  }).visit(context.program);
  return index;
};

const cloudflareMemberMutationIndex = (context) => {
  context.memberMutationIndex ??= cloudflareCreateMemberMutationIndex(context);
  return context.memberMutationIndex;
};

const cloudflarePriorMutationCount = (mutations, position) => {
  let lower = 0;
  let upper = mutations.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (mutations[middle].node.end <= position) lower = middle + 1;
    else upper = middle;
  }
  return lower;
};

const cloudflareDirectLocalBindingValues = (
  node,
  identifier,
  context,
  seen = new Set()
) => {
  const name = identifierName(identifier);
  if (!name) return [];
  const binding = artifactOwnerLexicalBinding(node, name, context);
  const bindingWasReassigned = binding
    ? artifactOwnerLexicalMutations(binding, name, context).some(
        (mutation) =>
          nodeType(mutation.node) !== 'AssignmentExpression' ||
          nodeType(mutation.node.left) !== 'MemberExpression'
      )
    : false;
  if (
    !binding ||
    cloudflareParameterBinding(binding) ||
    seen.has(binding.digestNode) ||
    bindingWasReassigned
  ) {
    return [];
  }
  const values =
    nodeType(binding.digestNode) === 'VariableDeclarator'
      ? cloudflarePatternBindingValues(
          binding.digestNode.id,
          binding.digestNode.init,
          name,
          binding.digestNode,
          context
        )
      : [binding.value];
  const nextSeen = new Set(seen).add(binding.digestNode);
  return values.flatMap((source) => {
    const value = unwrapCloudflareExecutionTarget(source);
    return nodeType(value) === 'Identifier'
      ? cloudflareDirectLocalBindingValues(
          binding.digestNode,
          value,
          context,
          nextSeen
        )
      : value
        ? [value]
        : [];
  });
};

const cloudflareDirectLocalClassValues = (node, target, context) => {
  const unwrapped = unwrapCloudflareExecutionTarget(target);
  if (isCloudflareClassNode(unwrapped)) return [unwrapped];
  if (nodeType(unwrapped) !== 'Identifier') return [];
  return cloudflareDirectLocalBindingValues(node, unwrapped, context).filter(
    isCloudflareClassNode
  );
};

const cloudflareDirectLocalClassMemberOwners = (
  node,
  classNode,
  member,
  context,
  seen = new Set()
) =>
  cloudflareClassMemberCandidates(node, classNode, member, false, context, seen)
    .map(({ target }) => target)
    .filter(isCloudflareFunctionNode);

const cloudflareDirectLocalObjectMemberOwners = (object, member, context) => {
  assertCloudflareComputedCallableDefinitions(object.properties, context);
  const property = object.properties
    .filter(
      (candidate) =>
        cloudflareLexicalPropertyKeyName(candidate, context) === member
    )
    .at(-1);
  return isCloudflareFunctionNode(property?.value) ? [property.value] : [];
};

const cloudflareLocalStaticMemberOwners = (execution, target, context) => {
  const member = cloudflareMemberName(target);
  if (nodeType(target) !== 'MemberExpression' || member === undefined) {
    return [];
  }
  const receiver = unwrapCloudflareExecutionTarget(target.object);
  const receivers =
    nodeType(receiver) === 'Identifier'
      ? cloudflareDirectLocalBindingValues(execution.node, receiver, context)
      : [receiver];
  return receivers.flatMap((candidate) => {
    if (nodeType(candidate) === 'ObjectExpression') {
      return cloudflareDirectLocalObjectMemberOwners(
        candidate,
        member,
        context
      );
    }
    if (nodeType(candidate) !== 'NewExpression') return [];
    return cloudflareDirectLocalClassValues(
      execution.node,
      candidate.callee,
      context
    ).flatMap((classNode) =>
      cloudflareDirectLocalClassMemberOwners(
        execution.node,
        classNode,
        member,
        context
      )
    );
  });
};

const cloudflareDirectExpressionStatement = (node, context) => {
  const statement = context.parentNodes.get(node);
  return nodeType(statement) === 'ExpressionStatement' &&
    statement.expression === node
    ? statement
    : undefined;
};

const cloudflareConditionalMutationAncestors = new Set([
  'CatchClause',
  'ConditionalExpression',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'IfStatement',
  'LogicalExpression',
  'SwitchCase',
  'SwitchStatement',
  'TryStatement',
  'WhileStatement',
]);

const cloudflareMutationDefinitelyDominatesRead = (mutation, read, context) => {
  const owner = cloudflareFunctionOwnerAt(read, context);
  if (mutation.owner !== owner) return false;
  const mutationStatement = cloudflareDirectExpressionStatement(
    mutation.node,
    context
  );
  const readStatement = cloudflareDirectExpressionStatement(read, context);
  if (!mutationStatement || !readStatement) return false;
  const container = context.parentNodes.get(mutationStatement);
  if (
    container !== context.parentNodes.get(readStatement) ||
    !new Set(['BlockStatement', 'Program']).has(nodeType(container)) ||
    mutationStatement.end > readStatement.start
  ) {
    return false;
  }
  let current = mutationStatement;
  while (current && current !== owner) {
    current = context.parentNodes.get(current);
    if (cloudflareConditionalMutationAncestors.has(nodeType(current))) {
      return false;
    }
  }
  return current === owner;
};

const cloudflareLocalMemberOwners = (node, target, context) => {
  if (nodeType(target) !== 'MemberExpression') return [];
  const mutations = cloudflarePriorMemberMutations(node, target, context);
  const owner = cloudflareFunctionOwnerAt(node, context);
  const directMutations = mutations.filter(
    (mutation) => mutation.owner === owner && mutation.node.end <= node.start
  );
  const latestDefiniteMutation = directMutations
    .filter((mutation) =>
      cloudflareMutationDefinitelyDominatesRead(mutation, node, context)
    )
    .sort((left, right) => left.node.end - right.node.end)
    .at(-1);
  const selectedMutations = latestDefiniteMutation
    ? directMutations.filter(
        (mutation) => mutation.node.end >= latestDefiniteMutation.node.end
      )
    : mutations;
  const mutated = cloudflarePriorMemberMutationCandidates(
    node,
    target,
    context,
    new Set(),
    selectedMutations
  )
    .map((candidate) => candidate.target)
    .filter(isCloudflareFunctionNode);
  const declared = cloudflareLocalStaticMemberOwners(
    { node, target },
    target,
    context
  );
  return [
    ...new Set(latestDefiniteMutation ? mutated : [...mutated, ...declared]),
  ];
};

const cloudflareDirectLocalCallableOwners = (
  node,
  target,
  context,
  seen = new Set()
) => {
  const unwrapped = unwrapCloudflareExecutionTarget(target);
  if (isCloudflareFunctionNode(unwrapped)) return [unwrapped];
  if (isCloudflareClassNode(unwrapped)) {
    const constructor = unwrapped.body.body.find(
      (member) => member.kind === 'constructor'
    );
    return isCloudflareFunctionNode(constructor?.value)
      ? [constructor.value]
      : [];
  }
  if (seen.has(unwrapped)) return [];
  const nextSeen = new Set(seen).add(unwrapped);
  if (nodeType(unwrapped) === 'Identifier') {
    return cloudflareDirectLocalBindingValues(node, unwrapped, context).flatMap(
      (value) =>
        cloudflareDirectLocalCallableOwners(node, value, context, nextSeen)
    );
  }
  if (
    new Set(['ConditionalExpression', 'LogicalExpression']).has(
      nodeType(unwrapped)
    )
  ) {
    return [
      unwrapped.left ?? unwrapped.consequent,
      unwrapped.right ?? unwrapped.alternate,
    ]
      .filter(Boolean)
      .flatMap((branch) =>
        cloudflareDirectLocalCallableOwners(node, branch, context, nextSeen)
      );
  }
  if (nodeType(unwrapped) === 'MemberExpression') {
    const localOwners = cloudflareLocalMemberOwners(node, unwrapped, context);
    if (!cloudflareRequiresComputedMemberResolution(unwrapped)) {
      return localOwners;
    }
    const targetKey = cloudflareNodeSemanticKey(unwrapped);
    const computedOwners = cloudflareLexicalTargetCandidates(
      node,
      unwrapped,
      context,
      nextSeen
    )
      .filter(
        (candidate) => cloudflareNodeSemanticKey(candidate.target) !== targetKey
      )
      .flatMap((candidate) =>
        cloudflareDirectLocalCallableOwners(
          node,
          candidate.target,
          context,
          nextSeen
        )
      );
    return [...new Set([...localOwners, ...computedOwners])];
  }
  if (nodeType(unwrapped) !== 'CallExpression') return [];
  if (isCloudflareBindCall(unwrapped.callee)) {
    return cloudflareDirectLocalCallableOwners(
      node,
      unwrapped.callee.object,
      context,
      nextSeen
    );
  }
  const factories = cloudflareDirectLocalCallableOwners(
    node,
    unwrapped.callee,
    context,
    nextSeen
  );
  return factories.flatMap((factory) =>
    cloudflareFunctionReturnExpressions(factory).flatMap((returned) =>
      cloudflareDirectLocalCallableOwners(returned, returned, context, nextSeen)
    )
  );
};

const cloudflareDirectExecutionOwners = (execution, context) => {
  const cached = context.executionOwnersByNode.get(execution.node);
  if (cached) return cached;
  if (context.executionOwnersInProgress.has(execution.node)) return [];
  context.executionOwnersInProgress.add(execution.node);
  try {
    const normalized = cloudflareNormalizedMetaExecutions(
      execution,
      context,
      false
    );
    if (normalized.length !== 1 || normalized[0] !== execution) {
      const owners = [
        ...new Set(
          normalized.flatMap((candidate) =>
            cloudflareDirectExecutionOwners(candidate, context)
          )
        ),
      ];
      context.executionOwnersByNode.set(execution.node, owners);
      return owners;
    }
    const target = unwrapCloudflareExecutionTarget(execution.target);
    const local = cloudflareDirectLocalCallableOwners(
      execution.node,
      target,
      context
    );
    const direct =
      local.length > 0
        ? local
        : nodeType(target) === 'MemberExpression'
          ? cloudflareLocalMemberOwners(execution.node, target, context)
          : [];
    const owners = [...new Set(direct)];
    context.executionOwnersByNode.set(execution.node, owners);
    return owners;
  } finally {
    context.executionOwnersInProgress.delete(execution.node);
  }
};

const cloudflareInvocationEdgesByCallee = (context) => {
  if (
    context.invocationEdgesByCallee &&
    context.invocationEdgesEpoch === context.factoryBindingEpoch
  ) {
    return context.invocationEdgesByCallee;
  }
  if (context.invocationEdgesInProgress) return new Map();
  context.invocationEdgesInProgress = true;
  const edges = new Map();
  let work = 0;
  try {
    cloudflareExecutionIndex(context).forEach((executions, caller) =>
      executions.forEach((execution) =>
        cloudflareDirectExecutionOwners(execution, context).forEach(
          (callee) => {
            work += 1;
            assert(
              work <= cloudflareAnalysisWorkLimit,
              cloudflareAnalysisWorkMessage
            );
            const incoming = edges.get(callee) ?? [];
            incoming.push({ caller, node: execution.node });
            edges.set(callee, incoming);
          }
        )
      )
    );
    context.invocationEdgesByCallee = edges;
    context.invocationEdgesEpoch = context.factoryBindingEpoch;
    return edges;
  } finally {
    context.invocationEdgesInProgress = false;
  }
};

const cloudflareEventOccurrencesByOwner = (owner, node, context) => {
  const edges = cloudflareInvocationEdgesByCallee(context);
  const occurrences = new Map([[owner, [node]]]);
  const pending = [owner];
  const visited = new Set();
  let work = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const incoming = edges.get(current) ?? [];
    work += incoming.length;
    assert(work <= cloudflareAnalysisWorkLimit, cloudflareAnalysisWorkMessage);
    incoming.forEach((edge) => {
      const existing = occurrences.get(edge.caller) ?? [];
      if (!existing.includes(edge.node)) existing.push(edge.node);
      occurrences.set(edge.caller, existing);
      pending.push(edge.caller);
    });
  }
  return occurrences;
};

const cloudflareOccurrenceRunsBefore = (mutation, read) =>
  mutation.end <= read.start;

const cloudflareMutationOwnerRunsBeforeRead = (
  mutation,
  node,
  readPosition,
  readOwner,
  context
) => {
  if (mutation.owner === readOwner) return mutation.node.end <= readPosition;
  const mutationOccurrences = cloudflareEventOccurrencesByOwner(
    mutation.owner,
    mutation.node,
    context
  );
  const readOccurrences = cloudflareEventOccurrencesByOwner(
    readOwner,
    node,
    context
  );
  for (const [owner, mutationNodes] of mutationOccurrences) {
    const readNodes = readOccurrences.get(owner) ?? [];
    if (
      mutationNodes.some((mutationNode) =>
        readNodes.some((readNode) =>
          cloudflareOccurrenceRunsBefore(mutationNode, readNode)
        )
      )
    ) {
      return true;
    }
  }
  return false;
};

const cloudflarePriorMutationEntries = (
  byMember,
  member,
  position,
  readOwner
) => {
  const exact = byMember?.get(String(member)) ?? [];
  const wildcard = byMember?.get(cloudflareWildcardMutationMember) ?? [];
  const prior = (mutations) => [
    ...mutations.slice(0, cloudflarePriorMutationCount(mutations, position)),
    ...mutations
      .slice(cloudflarePriorMutationCount(mutations, position))
      .filter((mutation) => mutation.owner !== readOwner),
  ];
  return [...prior(exact), ...prior(wildcard)];
};

const cloudflareConstructedPrototypeReceiverComponents = (
  node,
  target,
  context
) => {
  const receiver = unwrapCloudflareExecutionTarget(target);
  if (nodeType(receiver) !== 'NewExpression') return [];
  const constructors = [receiver.callee];
  const classes = cloudflareDirectLocalClassValues(
    node,
    receiver.callee,
    context
  );
  classes.forEach((classNode) => {
    if (classNode.superClass) constructors.push(classNode.superClass);
  });
  return [
    ...new Set(
      constructors
        .map((constructor) =>
          cloudflareReceiverComponent(
            node,
            cloudflareProjectionMember(constructor, 'prototype'),
            context
          )
        )
        .filter(Boolean)
    ),
  ];
};

const cloudflarePriorMemberMutations = (node, target, context) => {
  const member = cloudflareMemberName(target);
  const readPosition = Math.max(node.start, target.object?.end ?? node.start);
  const receiver = cloudflareReceiverComponent(node, target.object, context);
  const receiverComponents = new Set([
    receiver,
    ...cloudflareConstructedPrototypeReceiverComponents(
      node,
      target.object,
      context
    ),
  ]);
  const owner = cloudflareFunctionOwnerAt(node, context);
  const index = cloudflareMemberMutationIndex(context);
  const entriesFor = (receiverKey) => {
    const byMember = index.get(receiverKey);
    if (member !== undefined) {
      return cloudflarePriorMutationEntries(
        byMember,
        member,
        readPosition,
        owner
      );
    }
    return [...(byMember?.values() ?? [])].flatMap((mutations) => [
      ...mutations.slice(
        0,
        cloudflarePriorMutationCount(mutations, readPosition)
      ),
      ...mutations
        .slice(cloudflarePriorMutationCount(mutations, readPosition))
        .filter((mutation) => mutation.owner !== owner),
    ]);
  };
  const entries = [
    ...[...receiverComponents].flatMap(entriesFor),
    ...entriesFor(cloudflareOpaqueMutationReceiver).filter(
      (mutation) => !receiverComponents.has(mutation.sourceReceiverComponent)
    ),
  ];
  consumeCloudflareAnalysisWork(context, entries.length);
  return entries.filter(
    (mutation) =>
      !isStaticallyUnreachableCloudflareNode(mutation.node, context) &&
      cloudflareMutationOwnerRunsBeforeRead(
        mutation,
        node,
        readPosition,
        owner,
        context
      )
  );
};

const cloudflareObjectAssignMutationCandidates = (
  node,
  mutation,
  member,
  context,
  seen
) => {
  const candidates = mutation.sources.flatMap((source) =>
    cloudflareLexicalTargetCandidates(mutation.node, source, context, seen)
  );
  assert(
    candidates.every(
      ({ target: candidate }) =>
        nodeType(candidate) === 'ObjectExpression' &&
        candidate.properties.every(
          (property) => nodeType(property) !== 'SpreadElement'
        )
    ),
    cloudflareOpaqueMemberMutationMessage
  );
  return candidates.flatMap((candidate) => {
    const properties = candidate.target.properties.filter(
      (property) => propertyKeyName(property) === member
    );
    const accessorCandidates = cloudflareAccessorCandidates(
      properties,
      context,
      seen
    );
    if (accessorCandidates !== undefined) {
      return inheritCloudflareCandidateContexts(candidate, accessorCandidates);
    }
    return properties.flatMap((property) =>
      inheritCloudflareCandidateContexts(
        candidate,
        cloudflareLexicalTargetCandidates(node, property.value, context, seen)
      )
    );
  });
};

const cloudflareDefinePropertiesDescriptorCandidates = (
  node,
  descriptorSource,
  descriptorCandidate,
  context,
  seen
) => {
  const descriptor = descriptorCandidate.target;
  const allowedFields = new Set([
    'configurable',
    'enumerable',
    'get',
    'set',
    'value',
    'writable',
  ]);
  assert(
    nodeType(descriptor) === 'ObjectExpression' &&
      descriptor.properties.every(
        (property) =>
          nodeType(property) !== 'SpreadElement' &&
          property.kind === 'init' &&
          allowedFields.has(propertyKeyName(property))
      ),
    cloudflareOpaqueMemberMutationMessage
  );
  const valueProperty = descriptor.properties.findLast(
    (property) => propertyKeyName(property) === 'value'
  );
  const getterProperty = descriptor.properties.findLast(
    (property) => propertyKeyName(property) === 'get'
  );
  assert(
    !valueProperty ||
      !getterProperty ||
      cloudflareStaticallyUndefined(getterProperty.value, node, context),
    cloudflareAccessorAmbiguityMessage
  );
  const mutatedValues = cloudflarePriorMemberMutationCandidates(
    node,
    cloudflareProjectionMember(descriptorSource, 'value'),
    context,
    seen
  );
  const ownValues = valueProperty
    ? inheritCloudflareCandidateContexts(
        descriptorCandidate,
        cloudflareLexicalTargetCandidates(
          valueProperty.value,
          valueProperty.value,
          context,
          seen
        )
      )
    : [];
  if (mutatedValues.length > 0 || ownValues.length > 0) {
    return [...mutatedValues, ...ownValues];
  }
  const mutatedGetters = cloudflarePriorMemberMutationCandidates(
    node,
    cloudflareProjectionMember(descriptorSource, 'get'),
    context,
    seen
  );
  if (mutatedGetters.length > 0) {
    return mutatedGetters.flatMap((getter) => {
      assert(
        isCloudflareFunctionNode(getter.target) ||
          cloudflareStaticallyUndefined(getter.target, node, context),
        cloudflareOpaqueMemberMutationMessage
      );
      return isCloudflareFunctionNode(getter.target)
        ? inheritCloudflareCandidateContexts(
            getter,
            cloudflareAccessorReturnCandidates(
              { value: getter.target },
              context,
              seen
            )
          )
        : [];
    });
  }
  assert(getterProperty, cloudflareOpaqueMemberMutationMessage);
  if (cloudflareStaticallyUndefined(getterProperty.value, node, context)) {
    return [];
  }
  const getterCandidates = inheritCloudflareCandidateContexts(
    descriptorCandidate,
    cloudflareLexicalTargetCandidates(
      getterProperty.value,
      getterProperty.value,
      context,
      seen
    )
  );
  return getterCandidates.flatMap((getter) => {
    assert(
      isCloudflareFunctionNode(getter.target),
      cloudflareOpaqueMemberMutationMessage
    );
    return inheritCloudflareCandidateContexts(
      getter,
      cloudflareAccessorReturnCandidates(
        { value: getter.target },
        context,
        seen
      )
    );
  });
};

const cloudflareDefinePropertiesObjectCandidates = (
  node,
  source,
  context,
  seen
) =>
  cloudflareLexicalTargetCandidates(node, source, context, seen).filter(
    ({ target }) => nodeType(target) === 'ObjectExpression'
  );

const cloudflareDefinePropertiesMapDescriptors = (
  node,
  source,
  member,
  context,
  seen
) => {
  const maps = cloudflareDefinePropertiesObjectCandidates(
    node,
    source,
    context,
    seen
  );
  assert(maps.length > 0, cloudflareOpaqueMemberMutationMessage);
  const mutated = cloudflarePriorMemberMutationCandidates(
    node,
    cloudflareProjectionMember(source, member),
    context,
    seen
  ).map((candidate) => ({
    candidate,
    source: cloudflareProjectionMember(source, member),
  }));
  const own = maps.flatMap((mapCandidate) => {
    assert(
      mapCandidate.target.properties.every(
        (property) =>
          nodeType(property) !== 'SpreadElement' &&
          property.kind === 'init' &&
          propertyKeyName(property) !== undefined
      ),
      cloudflareOpaqueMemberMutationMessage
    );
    const property = mapCandidate.target.properties.findLast(
      (candidate) => propertyKeyName(candidate) === member
    );
    if (!property) return [];
    return inheritCloudflareCandidateContexts(
      mapCandidate,
      cloudflareLexicalTargetCandidates(
        property.value,
        property.value,
        context,
        seen
      )
    ).map((candidate) => ({ candidate, source: property.value }));
  });
  return [...mutated, ...own];
};

const cloudflareDefinePropertiesMutationCandidates = (
  node,
  mutation,
  member,
  context,
  seen
) => {
  assert(member !== undefined, cloudflareOpaqueMemberMutationMessage);
  const descriptors = [
    ...(mutation.descriptorValues ?? []).flatMap((source) =>
      cloudflareDefinePropertiesObjectCandidates(
        mutation.node,
        source,
        context,
        seen
      ).map((candidate) => ({ candidate, source }))
    ),
    ...(mutation.descriptorSources ?? []).flatMap((source) =>
      cloudflareDefinePropertiesMapDescriptors(
        mutation.node,
        source,
        member,
        context,
        seen
      )
    ),
  ];
  assert(descriptors.length > 0, cloudflareOpaqueMemberMutationMessage);
  return descriptors.flatMap(({ candidate, source }) =>
    cloudflareDefinePropertiesDescriptorCandidates(
      node,
      source,
      candidate,
      context,
      seen
    )
  );
};

const cloudflarePriorMemberMutationCandidates = (
  node,
  target,
  context,
  seen,
  mutations = cloudflarePriorMemberMutations(node, target, context)
) => {
  const member = cloudflareMemberName(target);
  return mutations.flatMap((mutation) => {
    if (mutation.member !== undefined && mutation.member !== member) {
      return [];
    }
    assert(
      !mutation.opaque,
      `${cloudflareOpaqueMemberMutationMessage} in ${context.analysisLabel} (${nodeType(mutation.node)}@${String(mutation.node.start)}:${String(mutation.node.end)}; mutation receiver ${String(mutation.receiverComponent)}; propagated from ${String(mutation.sourceReceiverComponent)})`
    );
    const resolvedMember = member ?? mutation.member;
    if (mutation.sources) {
      assert(
        resolvedMember !== undefined,
        cloudflareOpaqueMemberMutationMessage
      );
      return cloudflareObjectAssignMutationCandidates(
        node,
        mutation,
        resolvedMember,
        context,
        seen
      );
    }
    if (mutation.descriptorSources || mutation.descriptorValues) {
      assert(
        resolvedMember !== undefined,
        cloudflareOpaqueMemberMutationMessage
      );
      return cloudflareDefinePropertiesMutationCandidates(
        node,
        mutation,
        resolvedMember,
        context,
        seen
      );
    }
    return mutation.values.flatMap((value) =>
      cloudflareLexicalTargetCandidates(mutation.node, value, context, seen)
    );
  });
};

const cloudflareNormalizedMemberTargetCandidates = (
  node,
  target,
  context,
  seen
) => {
  const assignedMembers = cloudflareObjectAssignMemberCandidates(
    node,
    target,
    context,
    seen
  );
  if (assignedMembers) return assignedMembers;
  const mutatedMembers = cloudflarePriorMemberMutationCandidates(
    node,
    target,
    context,
    seen
  );
  const objectCandidates = cloudflareLexicalTargetCandidates(
    node,
    target.object,
    context,
    seen
  ).flatMap((candidate) =>
    cloudflareExpandedAggregateCandidates(node, candidate, context, seen)
  );
  if (new Set(['apply', 'call']).has(cloudflareMemberName(target))) {
    const invocationKind = cloudflareMemberName(target);
    const callableCandidates = objectCandidates.filter(
      (candidate) =>
        candidate.parameterName ||
        isCloudflareFunctionNode(candidate.target) ||
        new Set(['Identifier', 'MemberExpression']).has(
          nodeType(candidate.target)
        )
    );
    if (callableCandidates.length > 0) {
      return callableCandidates.map((candidate) => ({
        ...candidate,
        invocationKind,
      }));
    }
  }
  return [
    ...mutatedMembers,
    ...objectCandidates.flatMap((candidate) =>
      cloudflareMemberCandidate(node, target, candidate, context, seen)
    ),
  ];
};

const cloudflareFunctionReturnExpressions = (functionNode) =>
  nodeType(functionNode) === 'ArrowFunctionExpression' &&
  nodeType(functionNode.body) !== 'BlockStatement'
    ? [functionNode.body]
    : directReturnStatements(functionNode)
        .map(({ argument }) => argument)
        .filter(Boolean);

const cloudflareThisBindingName = '<cloudflare-this>';

const cloudflareExecutionReceiverCandidates = (call, context) => {
  if (nodeType(call) === 'NewExpression') return [{ target: call }];
  const callable = call.callee;
  return nodeType(callable) === 'MemberExpression'
    ? cloudflareLexicalTargetCandidates(
        call,
        callable.object,
        context,
        new Set()
      )
    : [];
};

const cloudflareFactoryParameterBindings = (call, ownerCandidate, context) =>
  new Map([
    ...(ownerCandidate.factoryBindings?.entries() ?? []),
    ...((ownerCandidate.factoryBindings?.has(cloudflareThisBindingName) ??
    false)
      ? []
      : [
          [
            cloudflareThisBindingName,
            cloudflareExecutionReceiverCandidates(call, context),
          ],
        ]),
    ...cloudflareParameterEntries(ownerCandidate.target).map(({ name }) => [
      name,
      cloudflareParameterExecutionCandidates(
        ownerCandidate.target,
        call,
        { name, path: [] },
        context,
        ownerCandidate
      ),
    ]),
  ]);

const cloudflareThisTargetCandidates = (node, target, context) => {
  const owner = cloudflareFunctionOwnerAt(node, context);
  return (
    context.factoryBindingsByFunction
      .get(owner)
      ?.get(cloudflareThisBindingName) ?? [{ target }]
  );
};

const cloudflareCandidateWithFactoryBindings = (candidate, bindings) => ({
  ...candidate,
  factoryBindings: bindings,
});

const cloudflareReturnedFunctionCandidates = (
  call,
  ownerCandidate,
  context,
  seen
) => {
  const bindings = cloudflareFactoryParameterBindings(
    call,
    ownerCandidate,
    context
  );
  return cloudflareFunctionReturnExpressions(ownerCandidate.target).flatMap(
    (returned) =>
      cloudflareLexicalTargetCandidates(
        returned,
        returned,
        context,
        seen
      ).flatMap((candidate) => {
        const projection = cloudflareParameterProjection(candidate);
        return projection
          ? cloudflareParameterExecutionCandidates(
              ownerCandidate.target,
              call,
              projection,
              context,
              ownerCandidate
            )
          : [cloudflareCandidateWithFactoryBindings(candidate, bindings)];
      })
  );
};

const withCloudflareFactoryResolution = (context, target, resolve) => {
  assert(
    context.factoryResolutionDepth < cloudflareFactoryResolutionLimit,
    `${cloudflareFactoryResolutionMessage} in ${context.analysisLabel} (${nodeType(target)}@${String(target?.start)}:${String(target?.end)})`
  );
  context.factoryResolutionDepth += 1;
  try {
    return resolve();
  } finally {
    context.factoryResolutionDepth -= 1;
  }
};

const resolveCloudflareFactoryCallTargetCandidates = (
  target,
  owners,
  context,
  seen
) => {
  const returned = owners.flatMap((owner) =>
    cloudflareReturnedFunctionCandidates(target, owner, context, seen)
  );
  return returned.length > 0 ? returned : [{ target }];
};

const cloudflareFactoryCallTargetCandidates = (node, target, context, seen) => {
  if (seen.has(target)) return [{ target }];
  const nextSeen = new Set(seen).add(target);
  const owners = cloudflareLexicalTargetCandidates(
    node,
    target.callee,
    context,
    nextSeen
  ).filter(
    ({ target: candidate }) =>
      isCloudflareFunctionNode(candidate) && !candidate.generator
  );
  return owners.length === 0
    ? [{ target }]
    : withCloudflareFactoryResolution(context, target, () =>
        resolveCloudflareFactoryCallTargetCandidates(
          target,
          owners,
          context,
          nextSeen
        )
      );
};

const cloudflareReflectiveReadTargetCandidates = (
  node,
  target,
  context,
  seen
) => {
  if (nodeType(target) !== 'CallExpression') return undefined;
  const callee = cloudflareAmbientAliasTarget(node, target.callee, context);
  if (nodeType(callee) !== 'MemberExpression') return undefined;
  const owner = cloudflareUnshadowedAmbientOwner(
    target,
    callee.object,
    context
  );
  const operation = cloudflareMemberName(callee);
  const [receiver, property] = target.arguments;
  if (owner === 'Reflect' && operation === 'get') {
    const member = cloudflareLiteralMemberName(property);
    assert(member !== undefined, cloudflareOpaqueMemberMutationMessage);
    return cloudflareLexicalTargetCandidates(
      node,
      cloudflareProjectionMember(receiver, member),
      context,
      seen
    );
  }
  if (owner === 'Object' && operation === 'getOwnPropertyDescriptor') {
    const member = cloudflareLiteralMemberName(property);
    assert(member !== undefined, cloudflareOpaqueMemberMutationMessage);
    return [
      {
        target: {
          properties: [
            {
              computed: false,
              key: { name: 'value', type: 'Identifier' },
              kind: 'init',
              method: false,
              shorthand: false,
              type: 'Property',
              value: cloudflareProjectionMember(receiver, member),
            },
          ],
          type: 'ObjectExpression',
        },
      },
    ];
  }
  return undefined;
};

const cloudflareCallTargetCandidates = (node, target, context, seen) => {
  const reflective = cloudflareReflectiveReadTargetCandidates(
    node,
    target,
    context,
    seen
  );
  if (reflective) return reflective;
  const reflected = cloudflareReflectConstructTargetCandidates(
    node,
    target,
    context,
    seen
  );
  if (reflected) return reflected;
  const assignedArguments = cloudflareUnshadowedObjectAssignArguments(
    target,
    context
  );
  if (assignedArguments?.[0]) {
    return cloudflareLexicalTargetCandidates(
      node,
      assignedArguments[0],
      context,
      seen
    );
  }
  const callee = target.callee;
  const boundTarget = isCloudflareBindCall(callee) ? callee.object : target;
  if (boundTarget === target) {
    return cloudflareFactoryCallTargetCandidates(node, target, context, seen);
  }
  const boundArguments = cloudflareBindArguments(target);
  const ambientBoundTarget = cloudflareAmbientAliasTarget(
    node,
    boundTarget,
    context
  );
  const directMetaTarget =
    new Set(['apply', 'construct']).has(
      cloudflareReflectOperation(node, ambientBoundTarget, context)
    ) || cloudflareFunctionPrototypeOperation(node, ambientBoundTarget, context)
      ? [{ target: ambientBoundTarget }]
      : undefined;
  return (
    directMetaTarget ??
    cloudflareLexicalTargetCandidates(node, boundTarget, context, seen)
  ).map((candidate) => ({
    ...candidate,
    boundArguments: [...(candidate.boundArguments ?? []), ...boundArguments],
    ...(candidate.boundThisValue !== undefined
      ? { boundThisValue: candidate.boundThisValue }
      : target.arguments?.[0] !== undefined
        ? { boundThisValue: target.arguments[0] }
        : {}),
  }));
};

const isCloudflareBindCall = (callee) =>
  nodeType(callee) === 'MemberExpression' &&
  cloudflareMemberName(callee) === 'bind';

const cloudflareBindArguments = (target) =>
  Array.isArray(target.arguments) ? target.arguments.slice(1) : [];

const cloudflareReflectConstructTargetCandidates = (
  node,
  target,
  context,
  seen
) => {
  if (
    !isCloudflareNamedMemberExecution(
      target.callee,
      'Reflect',
      'construct',
      context.topLevelBindings
    )
  ) {
    return undefined;
  }
  const argumentList = target.arguments[1];
  const arguments_ =
    nodeType(argumentList) === 'ArrayExpression'
      ? argumentList.elements.filter(Boolean)
      : [];
  return cloudflareNewTargetCandidates(
    node,
    {
      arguments: arguments_,
      callee: target.arguments[0],
      type: 'NewExpression',
    },
    context,
    seen
  );
};

function findCloudflareEnclosingClass(node, context) {
  let current = context.parentNodes.get(node);
  while (current) {
    if (isCloudflareClassNode(current)) return current;
    current = context.parentNodes.get(current);
  }
  return undefined;
}

function cloudflareClassConstructorCandidates(_node, classNode, context, seen) {
  const pending = [{ classNode, depth: 0 }];
  const visited = new Set([...seen].filter(isCloudflareClassNode));
  const candidates = [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (visited.has(current.classNode)) continue;
    assert(
      current.depth <= cloudflareFactoryResolutionLimit,
      cloudflareFactoryResolutionMessage
    );
    visited.add(current.classNode);
    consumeCloudflareAnalysisWork(context, 1);
    const ownConstructor = cloudflareClassConstructor(current.classNode);
    if (ownConstructor) {
      candidates.push({ target: ownConstructor });
      continue;
    }
    if (!current.classNode.superClass) continue;
    const nextSeen = new Set(seen).add(current.classNode);
    const superClasses = cloudflareLexicalTargetCandidates(
      current.classNode.superClass,
      current.classNode.superClass,
      context,
      nextSeen
    )
      .map(({ target }) => target)
      .filter(isCloudflareClassNode);
    consumeCloudflareAnalysisWork(context, superClasses.length);
    superClasses.forEach((superClass) =>
      pending.push({ classNode: superClass, depth: current.depth + 1 })
    );
  }
  return candidates;
}

function cloudflareSuperTargetCandidates(node, _target, context, seen) {
  const classNode = findCloudflareEnclosingClass(node, context);
  if (!classNode?.superClass) return [];
  return cloudflareLexicalTargetCandidates(
    classNode.superClass,
    classNode.superClass,
    context,
    seen
  ).flatMap(({ target }) =>
    isCloudflareClassNode(target)
      ? cloudflareClassConstructorCandidates(node, target, context, seen)
      : []
  );
}

const isCloudflareConstructorReturnCandidate = ({ target }) =>
  new Set([
    'ArrayExpression',
    'ArrowFunctionExpression',
    'ClassDeclaration',
    'ClassExpression',
    'FunctionDeclaration',
    'FunctionExpression',
    'CallExpression',
    'NewExpression',
    'ObjectExpression',
  ]).has(nodeType(target));

const cloudflareConstructorOwnerCandidates = (node, target, context, seen) =>
  cloudflareLexicalTargetCandidates(node, target.callee, context, seen).flatMap(
    (candidate) => {
      if (isCloudflareClassNode(candidate.target)) {
        return cloudflareClassConstructorChainCandidates(
          node,
          candidate.target,
          context,
          seen
        ).map(({ target: constructor }) => ({
          ...candidate,
          target: constructor,
        }));
      }
      return isCloudflareFunctionNode(candidate.target) ? [candidate] : [];
    }
  );

const cloudflareProxyConstructTrapOwnerCandidates = (
  node,
  target,
  context,
  seen
) =>
  cloudflareLexicalTargetCandidates(node, target.callee, context, seen).flatMap(
    (candidate) =>
      cloudflareDirectProxyHandlerCandidates(
        node,
        candidate.target,
        context,
        seen
      ).flatMap(({ target: handler }) =>
        handler.properties
          .filter((property) => propertyKeyName(property) === 'construct')
          .map(({ value }) => ({ ...candidate, target: value }))
          .filter(({ target: trap }) => isCloudflareFunctionNode(trap))
      )
  );

function cloudflareClassConstructorChainCandidates(
  _node,
  classNode,
  context,
  seen
) {
  const pending = [{ classNode, depth: 0 }];
  const visited = new Set([...seen].filter(isCloudflareClassNode));
  const candidates = [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (visited.has(current.classNode)) continue;
    assert(
      current.depth <= cloudflareFactoryResolutionLimit,
      cloudflareFactoryResolutionMessage
    );
    visited.add(current.classNode);
    consumeCloudflareAnalysisWork(context, 1);
    const ownConstructor = cloudflareClassConstructor(current.classNode);
    if (ownConstructor) candidates.push({ target: ownConstructor });
    if (!current.classNode.superClass) continue;
    const nextSeen = new Set(seen).add(current.classNode);
    const superClasses = cloudflareLexicalTargetCandidates(
      current.classNode.superClass,
      current.classNode.superClass,
      context,
      nextSeen
    )
      .map(({ target }) => target)
      .filter(isCloudflareClassNode);
    consumeCloudflareAnalysisWork(context, superClasses.length);
    superClasses.forEach((superClass) =>
      pending.push({ classNode: superClass, depth: current.depth + 1 })
    );
  }
  return candidates;
}

const cloudflareNewTargetCandidates = (node, target, context, seen) => {
  const proxyTrapOwners = cloudflareProxyConstructTrapOwnerCandidates(
    node,
    target,
    context,
    seen
  );
  const constructorOwners =
    proxyTrapOwners.length > 0
      ? proxyTrapOwners
      : cloudflareConstructorOwnerCandidates(node, target, context, seen);
  const returned = constructorOwners
    .flatMap((owner) =>
      cloudflareReturnedFunctionCandidates(target, owner, context, seen)
    )
    .filter(isCloudflareConstructorReturnCandidate);
  return returned.length > 0 ? returned : [{ target }];
};

const cloudflareTaggedTargetCandidates = (node, target, context, seen) => {
  const execution = {
    arguments: cloudflareTaggedExecutionArguments(target),
    callee: target.tag,
    type: 'CallExpression',
  };
  const returned = cloudflareLexicalTargetCandidates(
    node,
    target.tag,
    context,
    seen
  )
    .filter(({ target: candidate }) => isCloudflareFunctionNode(candidate))
    .flatMap((owner) =>
      cloudflareReturnedFunctionCandidates(execution, owner, context, seen)
    );
  return returned.length > 0 ? returned : [{ target }];
};

const cloudflareAssignmentTargetCandidates = (node, target, context, seen) =>
  (target.operator === '='
    ? [target.right]
    : [target.left, target.right]
  ).flatMap((candidate) =>
    cloudflareLexicalTargetCandidates(node, candidate, context, seen)
  );

const unknownCloudflareStaticValue = Symbol('unknown static value');

const cloudflareStaticTemplateValue = (node, depth) => {
  let value = '';
  for (let index = 0; index < node.quasis.length; index += 1) {
    value += node.quasis[index]?.value?.cooked ?? '';
    if (index >= node.expressions.length) continue;
    const expression = cloudflareStaticValue(node.expressions[index], depth);
    if (expression === unknownCloudflareStaticValue) {
      return unknownCloudflareStaticValue;
    }
    value += String(expression);
  }
  return value;
};

const cloudflareStaticAdditionValue = (node, depth) => {
  const left = cloudflareStaticValue(node.left, depth);
  const right = cloudflareStaticValue(node.right, depth);
  if (
    left === unknownCloudflareStaticValue ||
    right === unknownCloudflareStaticValue
  ) {
    return unknownCloudflareStaticValue;
  }
  try {
    return left + right;
  } catch {
    return unknownCloudflareStaticValue;
  }
};

const cloudflareStaticValue = (node, depth = 0) => {
  if (depth >= cloudflareParameterProjectionDepthLimit) {
    return unknownCloudflareStaticValue;
  }
  if (nodeType(node) === 'Literal') return node.value;
  if (nodeType(node) === 'UnaryExpression' && node.operator === 'void') {
    return undefined;
  }
  if (nodeType(node) === 'TemplateLiteral') {
    return cloudflareStaticTemplateValue(node, depth + 1);
  }
  if (nodeType(node) === 'BinaryExpression' && node.operator === '+') {
    return cloudflareStaticAdditionValue(node, depth + 1);
  }
  if (
    new Set(['ChainExpression', 'ParenthesizedExpression']).has(nodeType(node))
  ) {
    return cloudflareStaticValue(node.expression, depth + 1);
  }
  return unknownCloudflareStaticValue;
};

const cloudflareLogicalReachableSide = (logical) => {
  const value = cloudflareStaticValue(logical.left);
  if (value === unknownCloudflareStaticValue) return undefined;
  if (logical.operator === '&&') return value ? 'right' : 'left';
  if (logical.operator === '||') return value ? 'left' : 'right';
  if (logical.operator === '??')
    return value === null || value === undefined ? 'right' : 'left';
  return undefined;
};

const cloudflareLogicalTargetCandidates = (node, target, context, seen) => {
  const reachableSide = cloudflareLogicalReachableSide(target);
  const branches = reachableSide
    ? [target[reachableSide]]
    : [target.left, target.right];
  return branches.flatMap((branch) =>
    cloudflareLexicalTargetCandidates(node, branch, context, seen).map(
      (candidate) => ({
        ...candidate,
        safeFalsyShortCircuit:
          branch === target.left && target.operator === '&&',
      })
    )
  );
};

const isStaticallyUnreachableCloudflareNode = (node, lexicalContext) => {
  let current = node;
  let parent = lexicalContext.parentNodes.get(current);
  while (parent) {
    if (nodeType(parent) === 'LogicalExpression') {
      const reachableSide = cloudflareLogicalReachableSide(parent);
      if (
        reachableSide &&
        current === parent[reachableSide === 'left' ? 'right' : 'left']
      ) {
        return true;
      }
    }
    current = parent;
    parent = lexicalContext.parentNodes.get(current);
  }
  return false;
};

const cloudflareLexicalCandidateReaders = {
  AssignmentExpression: cloudflareAssignmentTargetCandidates,
  CallExpression: cloudflareCallTargetCandidates,
  ConditionalExpression: (node, target, context, seen) =>
    [target.consequent, target.alternate].flatMap((branch) =>
      cloudflareLexicalTargetCandidates(node, branch, context, seen)
    ),
  Identifier: cloudflareIdentifierTargetCandidates,
  LogicalExpression: cloudflareLogicalTargetCandidates,
  MemberExpression: cloudflareMemberTargetCandidates,
  NewExpression: cloudflareNewTargetCandidates,
  Super: cloudflareSuperTargetCandidates,
  TaggedTemplateExpression: cloudflareTaggedTargetCandidates,
  ThisExpression: cloudflareThisTargetCandidates,
};

const cloudflareTargetResolutionDiagnostic = (context, target) => {
  const root = context.targetResolutionRoot ?? target;
  const describe = (node) => {
    const name = identifierName(node);
    const member = cloudflareMemberName(node);
    const detail = name ?? member;
    return `${nodeType(node)}${detail === undefined ? '' : `(${detail})`}@${String(node?.start)}:${String(node?.end)}`;
  };
  const stack = context.targetResolutionStack
    .slice(-8)
    .map(describe)
    .join(' > ');
  return `${cloudflareTargetResolutionWorkMessage} in ${context.analysisLabel} (${describe(root)}; leaf ${describe(target)}; stack ${stack})`;
};

const beginCloudflareTargetResolution = (context, target) => {
  assert(
    context.targetResolutionDepth < cloudflareTargetResolutionDepthLimit,
    `${cloudflareTargetResolutionWorkMessage} depth in ${context.analysisLabel} (${cloudflareTargetResolutionDiagnostic(context, target)})`
  );
  if (context.targetResolutionDepth === 0) {
    context.targetResolutionRoot = target;
    context.targetResolutionWork = 0;
  }
  context.targetResolutionDepth += 1;
  context.targetResolutionStack.push(target);
  context.targetResolutionWork += 1;
  assert(
    context.targetResolutionWork <= cloudflareTargetResolutionWorkLimit,
    cloudflareTargetResolutionDiagnostic(context, target)
  );
};

const completeCloudflareTargetResolution = (context, target, candidates) => {
  context.targetResolutionWork += candidates.length;
  consumeCloudflareAnalysisWork(context, candidates.length);
  assert(
    context.targetResolutionWork <= cloudflareTargetResolutionWorkLimit,
    cloudflareTargetResolutionDiagnostic(context, target)
  );
  return candidates;
};

const consumeCloudflareAnalysisWork = (context, amount) => {
  context.analysisWork += amount;
  const root = context.targetResolutionRoot;
  assert(
    context.analysisWork <= cloudflareAnalysisWorkLimit,
    `${cloudflareAnalysisWorkMessage} in ${context.analysisLabel} (${nodeType(root)}@${String(root?.start)}:${String(root?.end)}; work=${String(context.analysisWork)}; increment=${String(amount)})`
  );
};

function cloudflareLexicalTargetCandidates(
  node,
  target,
  context,
  seen = new Set()
) {
  beginCloudflareTargetResolution(context, target);
  try {
    const unwrapped = unwrapCloudflareExecutionTarget(target);
    const reader = cloudflareLexicalCandidateReaders[nodeType(unwrapped)];
    const candidates = reader
      ? reader(node, unwrapped, context, seen)
      : [{ target: unwrapped }];
    return completeCloudflareTargetResolution(context, target, candidates);
  } finally {
    context.targetResolutionDepth -= 1;
    context.targetResolutionStack.pop();
  }
}

const cloudflareImportedAggregateSource = (spread, context) => {
  const hasStaticOwner = [
    nodeType(spread.argument) === 'Identifier',
    Boolean(context.artifactRoot),
    Boolean(context.chunkFile),
  ].every(Boolean);
  if (!hasStaticOwner) return undefined;
  const imports = staticImportsForBinding(
    context.program,
    spread.argument.name
  );
  if (imports.length !== 1) return undefined;
  const [{ importedName, source }] = imports;
  if (source?.startsWith('./') !== true) return undefined;
  return { importedName, source };
};

const cloudflareImportedAggregateTarget = (context, importedName, source) => {
  const ownerFile = path.resolve(path.dirname(context.chunkFile), source);
  if (!isWithinDirectory(ownerFile, context.artifactRoot)) return undefined;
  const manifestRecord = assertCloudflareChunkManifestMembership(
    context.artifactRoot,
    ownerFile,
    'aggregate spread owner'
  );
  cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord);
  const ownerProgram = readParsedModule(ownerFile).program;
  const exports = new Map(ownerProgram.body.flatMap(moduleExportEntries));
  const localName = exports.get(importedName);
  if (typeof localName !== 'string') return undefined;
  if (!cloudflareReturnedOwnersAreUnmutated(ownerProgram, [localName])) {
    return undefined;
  }
  return resolveCloudflareTarget(
    { name: localName, type: 'Identifier' },
    cloudflareTopLevelBindings(ownerProgram)
  );
};

const cloudflareAggregateLiteralEntries = (target) =>
  new Map([
    ['ArrayExpression', target?.elements],
    ['ObjectExpression', target?.properties],
  ]).get(nodeType(target)) ?? [];

const cloudflareImportedAggregateSpreadCandidates = (
  spread,
  context,
  expectedType
) => {
  const imported = cloudflareImportedAggregateSource(spread, context);
  if (!imported) return [];
  const target = cloudflareImportedAggregateTarget(
    context,
    imported.importedName,
    imported.source
  );
  if (nodeType(target) !== expectedType) return [];
  const properties = cloudflareAggregateLiteralEntries(target);
  if (properties.some((property) => nodeType(property) === 'SpreadElement'))
    return [];
  return [{ target }];
};

const cloudflareAggregateSpreadTargets = (
  spread,
  context,
  expectedType,
  seen
) => {
  const resolvedLocalCandidates = cloudflareLexicalTargetCandidates(
    spread.argument,
    spread.argument,
    context,
    seen
  );
  const localCandidates =
    resolvedLocalCandidates.length > 0 ||
    nodeType(spread.argument) !== 'Identifier'
      ? resolvedLocalCandidates
      : cloudflareDirectLocalBindingValues(
          spread,
          spread.argument,
          context
        ).map((target) => ({ target }));
  const candidates = localCandidates.every(
    (candidate) =>
      !isSupportedCloudflareAggregateSpreadCandidate(
        spread,
        candidate,
        context,
        expectedType
      )
  )
    ? cloudflareImportedAggregateSpreadCandidates(spread, context, expectedType)
    : localCandidates;
  const message = cloudflareAggregateSpreadDiagnostic(
    spread,
    context,
    candidates
  );
  assert(candidates.length > 0, message);
  assert(
    candidates.every((candidate) =>
      isSupportedCloudflareAggregateSpreadCandidate(
        spread,
        candidate,
        context,
        expectedType
      )
    ),
    message
  );
  return candidates.flatMap((candidate) => {
    if (
      expectedType === 'ArrayExpression' &&
      candidate.parameterName &&
      nodeType(candidate.target) !== 'ArrayExpression'
    ) {
      return [cloudflareSymbolicArraySpreadCandidate(candidate)];
    }
    if (
      expectedType === 'ArrayExpression' &&
      (new Set(['CallExpression', 'MemberExpression']).has(
        nodeType(candidate.target)
      ) ||
        isCloudflareAmbientCollectionConstruction(
          spread,
          candidate.target,
          context
        ))
    ) {
      return [
        cloudflareOpaqueArraySpreadCandidate(
          candidate,
          isCloudflareAmbientCollectionConstruction(
            spread,
            candidate.target,
            context
          )
        ),
      ];
    }
    return nodeType(candidate.target) === expectedType
      ? cloudflareExpandedAggregateCandidates(
          spread.argument,
          candidate,
          context,
          seen
        )
      : [];
  });
};

const isCloudflareAmbientStringRecord = (spread, candidate, context) =>
  [
    nodeType(candidate.target) === 'MemberExpression',
    identifierName(candidate.target.object) === 'process',
    cloudflareMemberName(candidate.target) === 'env',
    !artifactOwnerLexicalBinding(spread.argument, 'process', context),
  ].every(Boolean);

const isCloudflareAmbientCollectionConstruction = (spread, target, context) => {
  if (nodeType(target) !== 'NewExpression') return false;
  const callee = unwrapCloudflareExecutionTarget(target.callee);
  const name = identifierName(callee);
  return (
    new Set(['Map', 'Set']).has(name) &&
    !artifactOwnerLexicalBinding(spread, name, context) &&
    !findStaticImport(context.program, name)
  );
};

const isSupportedCloudflareAggregateSpreadCandidate = (
  spread,
  candidate,
  context,
  expectedType
) =>
  [
    nodeType(candidate.target) === expectedType,
    expectedType === 'ObjectExpression' &&
      isCloudflareAmbientStringRecord(spread, candidate, context),
    expectedType === 'ObjectExpression' &&
      typeof candidate.parameterName === 'string',
    expectedType === 'ArrayExpression' &&
      typeof candidate.parameterName === 'string',
    expectedType === 'ArrayExpression' &&
      new Set(['CallExpression', 'MemberExpression']).has(
        nodeType(candidate.target)
      ),
    expectedType === 'ArrayExpression' &&
      isCloudflareAmbientCollectionConstruction(
        spread,
        candidate.target,
        context
      ),
    expectedType === 'ObjectExpression' &&
      candidate.safeFalsyShortCircuit === true,
  ].includes(true);

const cloudflareAggregateSpreadDiagnostic = (spread, context, candidates) =>
  `${cloudflareOpaqueAggregateSpreadMessage} in ${
    context.analysisLabel ?? 'unknown chunk'
  } (${nodeType(spread.argument)}@${String(spread.argument.start)}:${String(spread.argument.end)}:${identifierName(spread.argument) ?? ''} -> ${
    candidates
      .map(
        ({ target }) => `${nodeType(target)}:${identifierName(target) ?? ''}`
      )
      .join(',') || 'unresolved'
  })`;

const cloudflareSymbolicArraySpreadCandidate = (candidate) => ({
  ...candidate,
  target: {
    elements: [
      {
        cloudflareSymbolicParameterName: candidate.parameterName,
        cloudflareSymbolicParameterPath: candidate.parameterPath,
        cloudflareSymbolicArraySpread: true,
        cloudflareWildcardMember: true,
        computed: true,
        object: candidate.target,
        property: { name: '__cloudflareWildcard', type: 'Identifier' },
        type: 'MemberExpression',
      },
    ],
    type: 'ArrayExpression',
  },
});

const cloudflareOpaqueArraySpreadCandidate = (candidate, safeIteration) => ({
  ...candidate,
  target: {
    elements: [
      {
        cloudflareOpaqueSpreadElement: true,
        cloudflareSafeOpaqueSpreadIteration: safeIteration,
        name: '__cloudflareOpaqueSpreadElement',
        type: 'Identifier',
      },
    ],
    type: 'ArrayExpression',
  },
});

const cloudflareExpandedArrayElements = (_node, target, context, seen) =>
  target.elements.flatMap((element) =>
    nodeType(element) === 'SpreadElement'
      ? cloudflareAggregateSpreadTargets(
          element,
          context,
          'ArrayExpression',
          seen
        ).flatMap(({ target: array }) => array.elements)
      : [element]
  );

const cloudflareExpandedObjectProperties = (_node, target, context, seen) =>
  target.properties.flatMap((property) =>
    nodeType(property) === 'SpreadElement'
      ? cloudflareAggregateSpreadTargets(
          property,
          context,
          'ObjectExpression',
          seen
        ).flatMap(({ target: object }) =>
          cloudflareSpreadObjectProperties(object)
        )
      : [property]
  );

const cloudflareSpreadObjectProperties = (object) => {
  assert(
    object.properties.every((property) => property.kind !== 'get'),
    cloudflareAggregateAccessorMessage
  );
  return object.properties;
};

const cloudflareExpandedAggregateCandidates = (
  node,
  candidate,
  context,
  seen = new Set()
) => {
  if (nodeType(candidate.target) === 'ArrayExpression') {
    return [
      {
        ...candidate,
        target: {
          ...candidate.target,
          elements: cloudflareExpandedArrayElements(
            node,
            candidate.target,
            context,
            seen
          ),
        },
      },
    ];
  }
  if (nodeType(candidate.target) === 'ObjectExpression') {
    return [
      {
        ...candidate,
        target: {
          ...candidate.target,
          properties: cloudflareExpandedObjectProperties(
            node,
            candidate.target,
            context,
            seen
          ),
        },
      },
    ];
  }
  return [candidate];
};

const cloudflarePropertyRunsAtClassEvaluation = (node, child) =>
  [
    node.static === true,
    node.computed === true &&
      child.start >= node.key.start &&
      child.end <= node.key.end,
  ].includes(true);

const cloudflareOwnerNodeReaders = {
  ArrowFunctionExpression: (node) => node,
  FunctionDeclaration: (node) => node,
  FunctionExpression: (node) => node,
  Program: (node) => node,
  PropertyDefinition: (node, lexicalContext, child) =>
    cloudflarePropertyRunsAtClassEvaluation(node, child)
      ? undefined
      : (findCloudflareEnclosingClass(node, lexicalContext) ??
        lexicalContext.program),
};

const findCloudflareFunctionOwner = (node, lexicalContext) => {
  let child = node;
  let current = lexicalContext.parentNodes.get(node);
  while (current) {
    const owner = cloudflareOwnerNodeReaders[nodeType(current)]?.(
      current,
      lexicalContext,
      child
    );
    if (owner) return owner;
    child = current;
    current = lexicalContext.parentNodes.get(current);
  }
  return lexicalContext.program;
};

const cloudflareFunctionOwnerAt = (node, lexicalContext) => {
  if (lexicalContext.functionOwners.has(node)) {
    return lexicalContext.functionOwners.get(node);
  }
  const owner = findCloudflareFunctionOwner(node, lexicalContext);
  lexicalContext.functionOwners.set(node, owner);
  return owner;
};

const cloudflareExecutionIndex = (lexicalContext) => {
  if (lexicalContext.executionsByOwner) {
    return lexicalContext.executionsByOwner;
  }
  const executionsByOwner = new Map();
  const record = (node, target) => {
    if (isStaticallyUnreachableCloudflareNode(node, lexicalContext)) return;
    const owner = cloudflareFunctionOwnerAt(node, lexicalContext);
    const executions = executionsByOwner.get(owner) ?? [];
    executions.push({ node, target });
    executionsByOwner.set(owner, executions);
  };
  new Visitor({
    CallExpression(node) {
      record(node, node.callee);
    },
    NewExpression(node) {
      record(node, node.callee);
    },
    TaggedTemplateExpression(node) {
      record(node, node.tag);
    },
  }).visit(lexicalContext.program);
  lexicalContext.executionsByOwner = executionsByOwner;
  return executionsByOwner;
};

const cloudflareExecutionTargets = (owner, lexicalContext) =>
  cloudflareExecutionIndex(lexicalContext).get(owner) ?? [];

const cloudflareMemberAccessIndex = (lexicalContext) => {
  if (lexicalContext.memberAccessesByOwner) {
    return lexicalContext.memberAccessesByOwner;
  }
  const accessesByOwner = new Map();
  new Visitor({
    MemberExpression(node) {
      if (isStaticallyUnreachableCloudflareNode(node, lexicalContext)) return;
      const owner = cloudflareFunctionOwnerAt(node, lexicalContext);
      const accesses = accessesByOwner.get(owner) ?? [];
      accesses.push(node);
      accessesByOwner.set(owner, accesses);
    },
  }).visit(lexicalContext.program);
  lexicalContext.memberAccessesByOwner = accessesByOwner;
  return accessesByOwner;
};

const cloudflareMemberAccesses = (owner, lexicalContext) =>
  cloudflareMemberAccessIndex(lexicalContext).get(owner) ?? [];

const cloudflarePatternAccessIndex = (lexicalContext) => {
  if (lexicalContext.patternAccessesByOwner) {
    return lexicalContext.patternAccessesByOwner;
  }
  const accessesByOwner = new Map();
  const record = (node, pattern, source) => {
    if (nodeType(pattern) !== 'ObjectPattern' || !source) return;
    if (isStaticallyUnreachableCloudflareNode(node, lexicalContext)) return;
    const owner = cloudflareFunctionOwnerAt(node, lexicalContext);
    const accesses = accessesByOwner.get(owner) ?? [];
    accesses.push({ node, pattern, source });
    accessesByOwner.set(owner, accesses);
  };
  new Visitor({
    AssignmentExpression(node) {
      record(node, node.left, node.right);
    },
    VariableDeclarator(node) {
      record(node, node.id, node.init);
    },
  }).visit(lexicalContext.program);
  lexicalContext.patternAccessesByOwner = accessesByOwner;
  return accessesByOwner;
};

const cloudflarePatternAccesses = (owner, lexicalContext) =>
  cloudflarePatternAccessIndex(lexicalContext).get(owner) ?? [];

const cloudflareParameterEntries = (functionNode) =>
  functionNode.params.flatMap((parameter, index) =>
    bindingNames(parameter).map((name) => ({ index, name, parameter }))
  );

const noCloudflarePatternBindingPath = () => undefined;

const cloudflareIdentifierBindingPath = (pattern, name) =>
  pattern.name === name ? [] : undefined;

const cloudflareWrappedBindingPath = (pattern, name) =>
  cloudflarePatternBindingPathUnchecked(pattern.left ?? pattern.argument, name);

const cloudflareAssignmentBindingPath = (pattern, name) => {
  const nested = cloudflarePatternBindingPathUnchecked(pattern.left, name);
  return nested
    ? [...nested, { defaultRange: [pattern.right.start, pattern.right.end] }]
    : undefined;
};

const cloudflareArrayBindingPath = (pattern, name) => {
  const index = pattern.elements.findIndex((element) =>
    bindingNames(element).includes(name)
  );
  if (index < 0) return undefined;
  const nested = cloudflarePatternBindingPathUnchecked(
    pattern.elements[index],
    name
  );
  if (!nested) return undefined;
  return nodeType(pattern.elements[index]) === 'RestElement'
    ? [{ restOffset: index }, ...nested]
    : [index, ...nested];
};

const cloudflareObjectRestBindingPath = (pattern, property, nested) => [
  {
    objectRest: pattern.properties
      .filter((candidate) => candidate !== property)
      .map(propertyKeyName),
  },
  ...nested,
];

const cloudflareObjectPropertyBindingPath = (property, nested) =>
  nodeType(property) === 'RestElement'
    ? undefined
    : [propertyKeyName(property), ...nested];

const cloudflareKnownObjectBindingPath = (pattern, property, name) => {
  const target = property.value ?? property.argument;
  const nested = cloudflarePatternBindingPathUnchecked(target, name);
  return nested
    ? (cloudflareObjectPropertyBindingPath(property, nested) ??
        cloudflareObjectRestBindingPath(pattern, property, nested))
    : undefined;
};

const cloudflareObjectBindingPath = (pattern, name) => {
  const property = pattern.properties.find((candidate) =>
    bindingNames(candidate.value ?? candidate.argument).includes(name)
  );
  return property
    ? cloudflareKnownObjectBindingPath(pattern, property, name)
    : undefined;
};

const cloudflarePatternBindingPathReaders = {
  ArrayPattern: cloudflareArrayBindingPath,
  AssignmentPattern: cloudflareAssignmentBindingPath,
  Identifier: cloudflareIdentifierBindingPath,
  ObjectPattern: cloudflareObjectBindingPath,
  RestElement: cloudflareWrappedBindingPath,
};

function cloudflarePatternBindingPathUnchecked(pattern, name) {
  const reader =
    cloudflarePatternBindingPathReaders[nodeType(pattern)] ??
    noCloudflarePatternBindingPath;
  return reader(pattern, name);
}

function cloudflarePatternBindingPath(pattern, name) {
  assertArtifactPatternBound(pattern);
  return cloudflarePatternBindingPathUnchecked(pattern, name);
}

const cloudflareParameterProjection = (candidate) =>
  candidate.parameterName
    ? {
        name: candidate.parameterName,
        path: candidate.parameterPath ?? [],
      }
    : undefined;

const cloudflareParameterProjectionKey = ({ name, path: projectionPath }) => (
  assert(
    projectionPath.length <= cloudflareParameterProjectionDepthLimit,
    cloudflareParameterProjectionDepthMessage
  ),
  JSON.stringify([name, projectionPath])
);

const parseCloudflareParameterProjection = (key) => {
  const [name, projectionPath] = JSON.parse(key);
  return { name, path: projectionPath };
};

const cloudflareProjectionMember = (object, member) => ({
  computed: true,
  object,
  property: { type: 'Literal', value: member },
  type: 'MemberExpression',
});

const cloudflareArrayRestCandidate = (candidate, member) =>
  nodeType(candidate.target) === 'ArrayExpression'
    ? [
        {
          ...candidate,
          target: {
            ...candidate.target,
            elements: candidate.target.elements.slice(member.restOffset),
          },
        },
      ]
    : [];

const cloudflareObjectRestCandidate = (candidate, member) =>
  nodeType(candidate.target) === 'ObjectExpression'
    ? [
        {
          ...candidate,
          target: {
            ...candidate.target,
            properties: candidate.target.properties.filter(
              (property) =>
                !member.objectRest.includes(propertyKeyName(property))
            ),
          },
        },
      ]
    : [];

const cloudflareRestCandidate = (candidate, member) => {
  const { objectRest, restOffset } = member ?? {};
  if (Number.isInteger(restOffset)) {
    return cloudflareArrayRestCandidate(candidate, member);
  }
  if (Array.isArray(objectRest)) {
    return cloudflareObjectRestCandidate(candidate, member);
  }
  return undefined;
};

const cloudflareDefaultProjectionRange = (member) => {
  const range = member?.defaultRange;
  return Array.isArray(range) &&
    range.length === 2 &&
    range.every(Number.isInteger)
    ? range
    : undefined;
};

const cloudflareDefaultCandidate = (
  node,
  candidate,
  member,
  lexicalContext
) => {
  const range = cloudflareDefaultProjectionRange(member);
  if (!range) return undefined;
  if (!cloudflareStaticallyUndefined(candidate.target, node, lexicalContext)) {
    return [candidate];
  }
  const source = lexicalContext.nodesByRange.get(
    `${String(range[0])}:${String(range[1])}`
  );
  assert(
    source,
    'Cloudflare parameter default source must be statically known'
  );
  return inheritCloudflareCandidateContexts(
    candidate,
    cloudflareSourceCandidates(node, source, lexicalContext)
  );
};

const cloudflareOpaqueArraySpreadCandidateAtMember = (
  node,
  candidate,
  member,
  lexicalContext
) => {
  if (!isCloudflareOpaqueArraySpreadProjection(member)) return undefined;
  const values = cloudflareWildcardMemberValues(candidate.target);
  if (values) {
    return values.flatMap((value) =>
      inheritCloudflareCandidateContexts(
        candidate,
        cloudflareSourceCandidates(node, value, lexicalContext)
      )
    );
  }
  return [
    {
      ...candidate,
      target: {
        ...candidate.target,
        cloudflareOpaqueSpreadElement: true,
      },
    },
  ];
};

const cloudflareParameterCandidateAtMember = (candidate, member) => [
  {
    ...candidate,
    parameterPath: [...(candidate.parameterPath ?? []), member],
  },
];

const cloudflareWildcardCandidateAtMember = (
  node,
  candidate,
  lexicalContext
) => {
  const values = cloudflareWildcardMemberValues(candidate.target);
  return values
    ? values.flatMap((value) =>
        cloudflareSourceCandidates(node, value, lexicalContext)
      )
    : [];
};

const cloudflareConcreteCandidateAtMember = (
  node,
  candidate,
  member,
  lexicalContext
) => {
  if (!candidate.target) return [];
  if (isCloudflareWildcardMemberProjection(member)) {
    return cloudflareWildcardCandidateAtMember(node, candidate, lexicalContext);
  }
  if (nodeType(candidate.target) === 'ArrayExpression') {
    const index = cloudflareCanonicalArrayIndex(member);
    if (index !== undefined) {
      const value = candidate.target.elements[index];
      return inheritCloudflareCandidateContexts(
        candidate,
        cloudflareSourceCandidates(node, value, lexicalContext)
      );
    }
  }
  if (nodeType(candidate.target) === 'ObjectExpression') {
    const property = candidate.target.properties.findLast(
      (current) => propertyKeyName(current) === member
    );
    if (!property) {
      return [{ ...candidate, target: undefined }];
    }
    if (!new Set(['get', 'set']).has(property.kind)) {
      return inheritCloudflareCandidateContexts(
        candidate,
        cloudflareSourceCandidates(node, property.value, lexicalContext)
      );
    }
  }
  return cloudflareLexicalTargetCandidates(
    node,
    cloudflareProjectionMember(candidate.target, member),
    lexicalContext
  );
};

const cloudflareCandidateAtMember = (node, candidate, member, lexicalContext) =>
  cloudflareExpandedAggregateCandidates(
    node,
    candidate,
    lexicalContext
  ).flatMap((expandedCandidate) =>
    cloudflareExpandedCandidateAtMember(
      node,
      expandedCandidate,
      member,
      lexicalContext
    )
  );

const cloudflareExpandedCandidateAtMember = (
  node,
  candidate,
  member,
  lexicalContext
) => {
  if (candidate.parameterName)
    return cloudflareParameterCandidateAtMember(candidate, member);
  const defaultCandidate = cloudflareDefaultCandidate(
    node,
    candidate,
    member,
    lexicalContext
  );
  if (defaultCandidate) return defaultCandidate;
  const opaqueSpreadCandidate = cloudflareOpaqueArraySpreadCandidateAtMember(
    node,
    candidate,
    member,
    lexicalContext
  );
  if (opaqueSpreadCandidate) return opaqueSpreadCandidate;
  const restCandidate = cloudflareRestCandidate(candidate, member);
  if (restCandidate) return restCandidate;
  return cloudflareConcreteCandidateAtMember(
    node,
    candidate,
    member,
    lexicalContext
  );
};

const cloudflareCandidatePathStep = (
  node,
  candidates,
  member,
  lexicalContext
) => {
  const expanded = candidates.flatMap((current) =>
    cloudflareCandidateAtMember(node, current, member, lexicalContext)
  );
  consumeCloudflareAnalysisWork(lexicalContext, expanded.length);
  return expanded;
};

const cloudflareCandidateAtPath = (
  node,
  candidate,
  projectionPath,
  lexicalContext
) => {
  let candidates = [candidate];
  projectionPath.forEach((member, index) => {
    const previous = candidates;
    candidates = cloudflareCandidatePathStep(
      node,
      previous,
      member,
      lexicalContext
    );
    if (
      candidates.length === 0 &&
      cloudflareDefaultProjectionRange(projectionPath[index + 1])
    ) {
      candidates = previous.map((current) => ({
        ...current,
        parameterName: undefined,
        parameterPath: undefined,
        target: undefined,
      }));
    }
  });
  return candidates;
};

const cloudflareSourceCandidates = (node, source, lexicalContext) =>
  source === undefined
    ? [{ target: undefined }]
    : cloudflareLexicalTargetCandidates(node, source, lexicalContext);

const cloudflareConcretePatternCandidates = (
  node,
  parameter,
  name,
  sourceCandidate,
  lexicalContext
) => {
  if (nodeType(parameter) === 'Identifier' && parameter.name === name) {
    return [sourceCandidate];
  }
  return cloudflareExpandedAggregateCandidates(
    node,
    sourceCandidate,
    lexicalContext
  ).flatMap((candidate) =>
    cloudflarePatternBindingValues(
      parameter,
      candidate.target,
      name,
      node,
      lexicalContext
    ).flatMap((value) =>
      inheritCloudflareCandidateContexts(
        candidate,
        cloudflareSourceCandidates(node, value, lexicalContext)
      )
    )
  );
};

const cloudflareProjectedPatternCandidates = (
  node,
  entry,
  sourceCandidate,
  projectionPath,
  lexicalContext
) => {
  if (!sourceCandidate.parameterName) {
    return cloudflareConcretePatternCandidates(
      node,
      entry.parameter,
      entry.name,
      sourceCandidate,
      lexicalContext
    ).flatMap((candidate) =>
      cloudflareCandidateAtPath(node, candidate, projectionPath, lexicalContext)
    );
  }
  const bindingPath = cloudflarePatternBindingPath(entry.parameter, entry.name);
  assert(
    bindingPath,
    'Cloudflare parameter projection must be statically known'
  );
  return cloudflareCandidateAtPath(
    node,
    sourceCandidate,
    [...bindingPath, ...projectionPath],
    lexicalContext
  );
};

const cloudflareMaximumArrayIndex = 4_294_967_294;
const cloudflareMaximumArrayIndexBigInt = BigInt(cloudflareMaximumArrayIndex);
const cloudflareCanonicalArrayIndex = (member) => {
  if (
    Number.isInteger(member) &&
    member >= 0 &&
    member <= cloudflareMaximumArrayIndex
  ) {
    return member;
  }
  if (
    typeof member === 'bigint' &&
    member >= 0n &&
    member <= cloudflareMaximumArrayIndexBigInt
  ) {
    return Number(member);
  }
  if (typeof member !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(member)) {
    return undefined;
  }
  const index = Number(member);
  return Number.isSafeInteger(index) && index <= cloudflareMaximumArrayIndex
    ? index
    : undefined;
};

const cloudflareRestParameterSources = (entry, arguments_, projectionPath) => {
  const [member, ...remainingPath] = projectionPath;
  assert(
    !isCloudflareWildcardMemberProjection(member),
    'Cloudflare load-effect analysis rejects unbounded computed rest-parameter projections'
  );
  const index = cloudflareCanonicalArrayIndex(member);
  if (index !== undefined) {
    return {
      projectionPath: remainingPath,
      sources: [arguments_[entry.index + index]],
    };
  }
  if (Number.isInteger(member?.restOffset)) {
    const [tailMember, ...tailPath] = remainingPath;
    const tailIndex = cloudflareCanonicalArrayIndex(tailMember);
    if (tailIndex !== undefined) {
      return {
        projectionPath: tailPath,
        sources: [arguments_[entry.index + member.restOffset + tailIndex]],
      };
    }
    return {
      projectionPath: remainingPath,
      sources: [
        {
          elements: arguments_.slice(entry.index + member.restOffset),
          type: 'ArrayExpression',
        },
      ],
    };
  }
  return { projectionPath, sources: arguments_.slice(entry.index) };
};

const cloudflareParameterSources = (entry, arguments_, projectionPath) =>
  nodeType(entry.parameter) === 'RestElement'
    ? cloudflareRestParameterSources(entry, arguments_, projectionPath)
    : {
        projectionPath,
        sources: [arguments_[entry.index]],
      };

const cloudflareMinimumParameterArgumentCount = (entry, projectionPath) => {
  if (nodeType(entry.parameter) !== 'RestElement') return entry.index + 1;
  const [member] = projectionPath;
  const index = cloudflareCanonicalArrayIndex(member);
  if (Number.isInteger(member?.restOffset)) {
    const tailIndex = cloudflareCanonicalArrayIndex(projectionPath[1]) ?? 0;
    return entry.index + member.restOffset + tailIndex + 1;
  }
  return index !== undefined ? entry.index + index + 1 : entry.index + 1;
};

const cloudflareSymbolicRestTargets = (
  candidates,
  minimumCount,
  existingCount,
  lexicalContext
) => {
  const count = Math.max(1, minimumCount - existingCount);
  consumeCloudflareAnalysisWork(lexicalContext, count * candidates.length);
  return candidates.flatMap((candidate) =>
    Array.from({ length: count }, (_unused, index) =>
      cloudflareProjectionMember(candidate.target, index)
    )
  );
};

const cloudflareExpandedParameterArguments = (
  execution,
  invocation,
  lexicalContext,
  minimumCount
) => {
  const arguments_ = cloudflareExecutionArguments(
    execution,
    invocation,
    lexicalContext
  );
  const expanded = [];
  arguments_.forEach((argument, index) => {
    if (nodeType(argument) !== 'SpreadElement') {
      expanded.push(argument);
      return;
    }
    const candidates = cloudflareBoundRestSpreadCandidates(
      execution,
      argument,
      lexicalContext
    );
    assert(
      candidates,
      `${cloudflareOpaqueSpreadArgumentsMessage} during parameter propagation in ${lexicalContext.analysisLabel} (${nodeType(execution)}@${String(execution.start)}:${String(execution.end)})`
    );
    const symbolic = candidates.every(
      ({ parameterName }) => parameterName !== undefined
    );
    assert(
      !symbolic || index === arguments_.length - 1,
      `${cloudflareOpaqueSpreadArgumentsMessage} during positional parameter propagation in ${lexicalContext.analysisLabel} (${nodeType(execution)}@${String(execution.start)}:${String(execution.end)})`
    );
    const targets = symbolic
      ? cloudflareSymbolicRestTargets(
          candidates,
          minimumCount,
          expanded.length,
          lexicalContext
        )
      : candidates.map(({ target }) => target);
    targets.forEach((target) => expanded.push(target));
  });
  return expanded;
};

const cloudflareParameterExecutionCandidates = (
  functionNode,
  execution,
  projection,
  lexicalContext,
  invocation
) => {
  const entry = cloudflareParameterEntries(functionNode).find(
    ({ name }) => name === projection.name
  );
  if (!entry) return [];
  const arguments_ = cloudflareExpandedParameterArguments(
    execution,
    invocation,
    lexicalContext,
    cloudflareMinimumParameterArgumentCount(entry, projection.path)
  );
  const { projectionPath, sources } = cloudflareParameterSources(
    entry,
    arguments_,
    projection.path
  );
  return sources.flatMap((source) =>
    cloudflareSourceCandidates(execution, source, lexicalContext).flatMap(
      (sourceCandidate) =>
        cloudflareProjectedPatternCandidates(
          execution,
          entry,
          sourceCandidate,
          projectionPath,
          lexicalContext
        )
    )
  );
};

const cloudflarePropagatedParameterProjections = (
  candidate,
  execution,
  summaries,
  lexicalContext
) => {
  if (!isCloudflareFunctionNode(candidate.target)) return [];
  return [...(summaries.get(candidate.target) ?? [])].flatMap((key) =>
    cloudflareParameterExecutionCandidates(
      candidate.target,
      execution,
      parseCloudflareParameterProjection(key),
      lexicalContext,
      candidate
    )
      .map(cloudflareParameterProjection)
      .filter(Boolean)
  );
};

const cloudflareArgumentParameterProjections = (execution, lexicalContext) =>
  cloudflareExecutionArguments(execution.node, undefined, lexicalContext)
    .flatMap((source) =>
      cloudflareSourceCandidates(
        execution.node,
        nodeType(source) === 'SpreadElement' ? source.argument : source,
        lexicalContext
      ).map((candidate) =>
        nodeType(source) === 'SpreadElement' && candidate.parameterName
          ? {
              ...candidate,
              parameterPath: [
                ...(candidate.parameterPath ?? []),
                cloudflareWildcardMemberProjection,
              ],
            }
          : candidate
      )
    )
    .map(cloudflareParameterProjection)
    .filter(Boolean);

const cloudflareFunctionPrototypeOperation = (node, target, context) => {
  if (nodeType(target) !== 'MemberExpression') return undefined;
  const operation = cloudflareMemberName(target);
  if (!new Set(['apply', 'call']).has(operation)) return undefined;
  const prototype = unwrapCloudflareExecutionTarget(target.object);
  if (
    nodeType(prototype) !== 'MemberExpression' ||
    cloudflareMemberName(prototype) !== 'prototype'
  ) {
    return undefined;
  }
  const owner = unwrapCloudflareExecutionTarget(prototype.object);
  const direct = identifierName(owner) === 'Function';
  const global =
    nodeType(owner) === 'MemberExpression' &&
    identifierName(owner.object) === 'globalThis' &&
    cloudflareMemberName(owner) === 'Function';
  if (!direct && !global) return undefined;
  const requiredGlobals = global ? ['Function', 'globalThis'] : ['Function'];
  return requiredGlobals.every(
    (name) =>
      !artifactOwnerLexicalBinding(node, name, context) &&
      !findStaticImport(context.program, name)
  )
    ? operation
    : undefined;
};

const cloudflareReflectOperation = (node, target, context) => {
  if (nodeType(target) !== 'MemberExpression') return undefined;
  return cloudflareUnshadowedAmbientOwner(node, target.object, context) ===
    'Reflect'
    ? cloudflareMemberName(target)
    : undefined;
};

const cloudflareSyntheticMetaExecution = (
  execution,
  target,
  arguments_,
  type,
  thisValue,
  lexicalContext
) => {
  const normalizedNode = {
    ...execution.node,
    arguments: arguments_,
    callee: target,
    type,
  };
  lexicalContext.parentNodes.set(
    normalizedNode,
    lexicalContext.parentNodes.get(execution.node)
  );
  return { node: normalizedNode, target, thisValue };
};

const cloudflareComputedInvocationExecutions = (execution, lexicalContext) => {
  if (!cloudflareRequiresComputedMemberResolution(execution.target)) {
    return undefined;
  }
  const targets = cloudflareStaticComputedMemberTargets(
    execution.node,
    execution.target,
    lexicalContext,
    new Set()
  );
  const unresolved =
    targets.length === 0 ||
    targets.some((target) => target.cloudflareWildcardMember === true);
  if (unresolved) {
    const parameterDriven = cloudflareLexicalTargetCandidates(
      execution.node,
      execution.target.property,
      lexicalContext,
      new Set()
    ).some((candidate) => candidate.parameterName !== undefined);
    const ambientOwner = cloudflareUnshadowedAmbientOwner(
      execution.node,
      execution.target.object,
      lexicalContext
    );
    assert(
      parameterDriven || ambientOwner === undefined,
      `${cloudflareOpaqueComputedCallableInvocationMessage} in ${lexicalContext.analysisLabel}`
    );
    return undefined;
  }
  return targets.map((target) =>
    cloudflareSyntheticMetaExecution(
      execution,
      target,
      execution.node.arguments ?? [],
      execution.node.type,
      execution.thisValue,
      lexicalContext
    )
  );
};

const cloudflareStaticMetaArgumentLists = (
  node,
  source,
  lexicalContext,
  allowOpaque
) => {
  const arrays = cloudflareStaticArrayCandidates(node, source, lexicalContext);
  if (!arrays && allowOpaque) return undefined;
  assert(
    arrays?.every(({ elements }) =>
      elements.every((element) => element !== null)
    ),
    cloudflareOpaqueApplyArgumentsMessage
  );
  return arrays.map(({ elements }) => elements);
};

const cloudflareMetaReceiverIsCallable = (
  node,
  receiver,
  lexicalContext,
  allowParameterReceiver
) => {
  const resolved = cloudflareAmbientAliasTarget(node, receiver, lexicalContext);
  if (
    cloudflareFunctionPrototypeOperation(node, resolved, lexicalContext) ||
    new Set(['apply', 'construct']).has(
      cloudflareReflectOperation(node, resolved, lexicalContext)
    )
  ) {
    return true;
  }
  return cloudflareLexicalTargetCandidates(node, receiver, lexicalContext).some(
    (candidate) =>
      isCloudflareFunctionNode(candidate.target) ||
      isCloudflareClassNode(candidate.target) ||
      (allowParameterReceiver && candidate.parameterName !== undefined)
  );
};

const cloudflareReflectMetaExecutions = (
  execution,
  operation,
  lexicalContext,
  allowParameterReceiver
) => {
  if (!new Set(['apply', 'construct']).has(operation)) return undefined;
  const arguments_ = execution.node.arguments ?? [];
  const lists = cloudflareStaticMetaArgumentLists(
    execution.node,
    arguments_[operation === 'apply' ? 2 : 1],
    lexicalContext,
    !allowParameterReceiver
  );
  return (lists ?? [[]]).map((list) =>
    cloudflareSyntheticMetaExecution(
      execution,
      arguments_[0],
      list,
      operation === 'construct' ? 'NewExpression' : 'CallExpression',
      operation === 'apply' ? arguments_[1] : undefined,
      lexicalContext
    )
  );
};

const cloudflareFunctionPrototypeMetaExecutions = (
  execution,
  operation,
  lexicalContext,
  allowParameterReceiver
) => {
  if (!operation || !execution.thisValue) return undefined;
  const arguments_ = execution.node.arguments ?? [];
  const lists =
    operation === 'call'
      ? [arguments_.slice(1)]
      : cloudflareStaticMetaArgumentLists(
          execution.node,
          arguments_[1],
          lexicalContext,
          !allowParameterReceiver
        );
  return (lists ?? [[]]).map((list) =>
    cloudflareSyntheticMetaExecution(
      execution,
      execution.thisValue,
      list,
      'CallExpression',
      arguments_[0],
      lexicalContext
    )
  );
};

const cloudflareCallApplyMetaExecutions = (
  execution,
  target,
  lexicalContext,
  allowParameterReceiver
) => {
  if (nodeType(target) !== 'MemberExpression') return undefined;
  const operation = cloudflareMemberName(target);
  if (!new Set(['apply', 'call']).has(operation)) return undefined;
  const receiver = target.object;
  if (
    !cloudflareMetaReceiverIsCallable(
      execution.node,
      receiver,
      lexicalContext,
      allowParameterReceiver
    )
  ) {
    return undefined;
  }
  const arguments_ = execution.node.arguments ?? [];
  const lists =
    operation === 'call'
      ? [arguments_.slice(1)]
      : cloudflareStaticMetaArgumentLists(
          execution.node,
          arguments_[1],
          lexicalContext,
          !allowParameterReceiver
        );
  return (lists ?? [[]]).map((list) =>
    cloudflareSyntheticMetaExecution(
      execution,
      receiver,
      list,
      'CallExpression',
      arguments_[0],
      lexicalContext
    )
  );
};

const cloudflareMetaCallableTarget = (
  node,
  target,
  lexicalContext,
  allowParameterReceiver
) => {
  if (
    new Set(['apply', 'construct']).has(
      cloudflareReflectOperation(node, target, lexicalContext)
    ) ||
    cloudflareFunctionPrototypeOperation(node, target, lexicalContext)
  ) {
    return true;
  }
  if (nodeType(target) !== 'MemberExpression') return false;
  return (
    new Set(['apply', 'call']).has(cloudflareMemberName(target)) &&
    cloudflareMetaReceiverIsCallable(
      node,
      target.object,
      lexicalContext,
      allowParameterReceiver
    )
  );
};

const cloudflareBoundMetaExecutions = (
  execution,
  lexicalContext,
  allowParameterReceiver
) => {
  const candidates = cloudflareLexicalTargetCandidates(
    execution.node,
    execution.target,
    lexicalContext,
    new Set()
  ).filter(
    (candidate) =>
      (candidate.boundArguments !== undefined ||
        candidate.boundThisValue !== undefined) &&
      cloudflareMetaCallableTarget(
        execution.node,
        candidate.target,
        lexicalContext,
        allowParameterReceiver
      )
  );
  if (candidates.length === 0) return undefined;
  consumeCloudflareAnalysisWork(lexicalContext, candidates.length);
  return candidates.map((candidate) =>
    cloudflareSyntheticMetaExecution(
      execution,
      candidate.target,
      cloudflareExpandedArguments(
        execution.node,
        [
          ...(candidate.boundArguments ?? []),
          ...(execution.node.arguments ?? []),
        ],
        lexicalContext
      ),
      'CallExpression',
      candidate.boundThisValue,
      lexicalContext
    )
  );
};

const cloudflareNormalizedMetaExecutionStep = (
  execution,
  lexicalContext,
  allowParameterReceiver
) => {
  const node = execution.node;
  if (nodeType(node) !== 'CallExpression') return undefined;
  if (
    importedCloudflareInvocation(
      lexicalContext.program,
      execution.target,
      lexicalContext.topLevelBindings
    )
  ) {
    return undefined;
  }
  const computed = cloudflareComputedInvocationExecutions(
    execution,
    lexicalContext
  );
  if (computed) return computed;
  const bound = cloudflareBoundMetaExecutions(
    execution,
    lexicalContext,
    allowParameterReceiver
  );
  if (bound) return bound;
  const target = cloudflareAmbientAliasTarget(
    node,
    execution.target,
    lexicalContext
  );
  const reflect = cloudflareReflectOperation(node, target, lexicalContext);
  return (
    cloudflareReflectMetaExecutions(
      execution,
      reflect,
      lexicalContext,
      allowParameterReceiver
    ) ??
    cloudflareFunctionPrototypeMetaExecutions(
      execution,
      cloudflareFunctionPrototypeOperation(node, target, lexicalContext),
      lexicalContext,
      allowParameterReceiver
    ) ??
    cloudflareCallApplyMetaExecutions(
      execution,
      target,
      lexicalContext,
      allowParameterReceiver
    )
  );
};

const cloudflareNormalizedMetaExecutions = (
  execution,
  lexicalContext,
  allowParameterReceiver,
  depth = 0
) => {
  assert(
    depth <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  const normalized = cloudflareNormalizedMetaExecutionStep(
    execution,
    lexicalContext,
    allowParameterReceiver
  );
  return normalized
    ? normalized.flatMap((candidate) =>
        cloudflareNormalizedMetaExecutions(
          candidate,
          lexicalContext,
          allowParameterReceiver,
          depth + 1
        )
      )
    : [execution];
};

const cloudflareParameterExecutions = (execution, lexicalContext) =>
  cloudflareNormalizedMetaExecutions(execution, lexicalContext, true);

const cloudflareExecutionParameterProjections = (
  execution,
  summaries,
  lexicalContext
) => {
  return cloudflareParameterExecutions(execution, lexicalContext).flatMap(
    (normalizedExecution) =>
      cloudflareNormalizedExecutionParameterProjections(
        normalizedExecution,
        summaries,
        lexicalContext
      )
  );
};

const cloudflareNormalizedExecutionParameterProjections = (
  execution,
  summaries,
  lexicalContext
) => {
  const crossesImportedBoundary = Boolean(
    importedCloudflareInvocation(
      lexicalContext.program,
      execution.target,
      lexicalContext.topLevelBindings
    )
  );
  if (crossesImportedBoundary) {
    return cloudflareArgumentParameterProjections(execution, lexicalContext);
  }
  const candidates = cloudflareLexicalTargetCandidates(
    execution.node,
    execution.target,
    lexicalContext
  );
  const direct = candidates.flatMap((candidate) => {
    const direct = cloudflareParameterProjection(candidate);
    return [
      ...(direct ? [direct] : []),
      ...cloudflarePropagatedParameterProjections(
        candidate,
        execution.node,
        summaries,
        lexicalContext
      ),
    ];
  });
  return candidates.some((candidate) => candidate.parameterName)
    ? [
        ...direct,
        ...cloudflareArgumentParameterProjections(execution, lexicalContext),
      ]
    : direct;
};

const addCloudflareInvokedParameter = (summary, parameterNames, projection) => {
  if (!parameterNames.has(projection.name)) return false;
  const key = cloudflareParameterProjectionKey(projection);
  if (summary.has(key)) return false;
  assert(
    summary.size < cloudflareParameterProjectionCountLimit,
    cloudflareParameterProjectionCountMessage
  );
  summary.add(key);
  return true;
};

const updateCloudflareInvokedParameterSummary = (
  owner,
  summaries,
  lexicalContext
) => {
  const parameterNames = new Set(
    cloudflareParameterEntries(owner).map(({ name }) => name)
  );
  const summary = summaries.get(owner);
  return cloudflareExecutionTargets(owner, lexicalContext)
    .flatMap((execution) =>
      cloudflareExecutionParameterProjections(
        execution,
        summaries,
        lexicalContext
      )
    )
    .reduce(
      (changed, projection) =>
        addCloudflareInvokedParameter(summary, parameterNames, projection) ||
        changed,
      false
    );
};

const cloudflareInvokedFunctionDependencies = (owner, lexicalContext) => {
  const cached = lexicalContext.invokedFunctionDependencies.get(owner);
  if (cached?.epoch === lexicalContext.factoryBindingEpoch) {
    return cached.dependencies;
  }
  const dependencies = cloudflareExecutionTargets(
    owner,
    lexicalContext
  ).flatMap((execution) => {
    const imported = importedCloudflareInvocation(
      lexicalContext.program,
      execution.target,
      lexicalContext.topLevelBindings
    );
    if (imported) {
      return [];
    }
    return cloudflareLexicalTargetCandidates(
      execution.node,
      execution.target,
      lexicalContext
    )
      .map((candidate) => candidate.target)
      .filter(isCloudflareFunctionNode);
  });
  lexicalContext.invokedFunctionDependencies.set(owner, {
    dependencies,
    epoch: lexicalContext.factoryBindingEpoch,
  });
  return dependencies;
};

const cloudflareInvokedFunctionClosure = (
  owner,
  lexicalContext,
  stableFunctions
) => {
  const functions = new Set();
  const pending = [owner];
  while (pending.length > 0) {
    const current = pending.pop();
    if (functions.has(current)) continue;
    functions.add(current);
    if (stableFunctions.has(current)) continue;
    pending.push(
      ...cloudflareInvokedFunctionDependencies(current, lexicalContext)
    );
  }
  return [...functions];
};

const ensureCloudflareInvokedParameterSummary = (summaries, functionNode) => {
  if (!summaries.has(functionNode)) summaries.set(functionNode, new Set());
};

const cloudflareReverseFunctionDependencies = (functions, lexicalContext) => {
  const reverseDependencies = new Map(
    functions.map((functionNode) => [functionNode, new Set()])
  );
  functions.forEach((caller) =>
    cloudflareInvokedFunctionDependencies(caller, lexicalContext).forEach(
      (dependency) => reverseDependencies.get(dependency)?.add(caller)
    )
  );
  return reverseDependencies;
};

const enqueueCloudflareInvokedSummaryOwner = (owner, pending, queued) => {
  if (queued.has(owner)) return;
  queued.add(owner);
  pending.push(owner);
};

const stabilizeCloudflareInvokedParameterSummaries = (
  functions,
  summaries,
  lexicalContext
) => {
  const reverseDependencies = cloudflareReverseFunctionDependencies(
    functions,
    lexicalContext
  );
  const pending = [...functions];
  const queued = new Set(pending);
  while (pending.length > 0) {
    const functionNode = pending.pop();
    queued.delete(functionNode);
    if (
      updateCloudflareInvokedParameterSummary(
        functionNode,
        summaries,
        lexicalContext
      )
    ) {
      (reverseDependencies.get(functionNode) ?? []).forEach((caller) =>
        enqueueCloudflareInvokedSummaryOwner(caller, pending, queued)
      );
    }
  }
};

const cloudflareInvokedParameterSummaries = (
  _program,
  owner,
  lexicalContext
) => {
  const currentState = lexicalContext.invokedParameterSummaryState;
  const state =
    currentState?.epoch === lexicalContext.factoryBindingEpoch
      ? currentState
      : {
          epoch: lexicalContext.factoryBindingEpoch,
          stableFunctions: new Set(),
          summaries: new Map(),
        };
  lexicalContext.invokedParameterSummaryState = state;
  const functions = cloudflareInvokedFunctionClosure(
    owner,
    lexicalContext,
    state.stableFunctions
  );
  functions.forEach((functionNode) =>
    ensureCloudflareInvokedParameterSummary(state.summaries, functionNode)
  );
  const unstableFunctions = functions.filter(
    (functionNode) => !state.stableFunctions.has(functionNode)
  );
  stabilizeCloudflareInvokedParameterSummaries(
    unstableFunctions,
    state.summaries,
    lexicalContext
  );
  unstableFunctions.forEach((functionNode) =>
    state.stableFunctions.add(functionNode)
  );
  return state.summaries;
};

const cloudflareInvokedParameterProjections = (
  functionNode,
  program,
  lexicalContext
) => {
  const invoked =
    cloudflareInvokedParameterSummaries(
      program,
      functionNode,
      lexicalContext
    ).get(functionNode) ?? new Set();
  return [...invoked].map(parseCloudflareParameterProjection);
};

export const inspectCloudflareInvokedParameterProjectionsForTesting = (
  source,
  ownerName
) => {
  const analysisLabel = 'invoked-parameters.fixture.js';
  const program = parseModuleSource(analysisLabel, source).program;
  const lexicalContext = createCloudflareLexicalContext(program, analysisLabel);
  const owner = resolveCloudflareTarget(
    { name: ownerName, type: 'Identifier' },
    lexicalContext.topLevelBindings
  );
  assert(
    isCloudflareFunctionNode(owner),
    `${analysisLabel} must expose function ${ownerName}`
  );
  return cloudflareInvokedParameterProjections(owner, program, lexicalContext);
};

const importedCloudflareNamespaceInvocation = (program, target, bindings) => {
  if (nodeType(target) !== 'MemberExpression') return undefined;
  const namespaceTarget = resolveCloudflareTarget(target.object, bindings);
  const localName = identifierName(namespaceTarget);
  const imported = findStaticImport(program, localName);
  const importedName = cloudflareMemberName(target);
  return asCloudflareNamespaceInvocation(imported, importedName);
};

const asCloudflareNamespaceInvocation = (imported, importedName) => {
  if (!imported) return undefined;
  if (imported.importKind !== 'namespace') return undefined;
  return importedName ? { ...imported, importedName } : undefined;
};

const importedCloudflareIdentifierInvocation = (program, target) => {
  const localName = identifierName(target);
  return localName ? findStaticImport(program, localName) : undefined;
};

const directImportedCloudflareInvocation = (program, target, bindings) => {
  const callable = cloudflareCallableTarget(target, bindings);
  return (
    importedCloudflareNamespaceInvocation(program, callable, bindings) ??
    importedCloudflareIdentifierInvocation(program, callable)
  );
};

const cloudflareReturnedCallProjection = Object.freeze({ callResult: true });
const isCloudflareReturnedCallProjection = (projection) =>
  projection?.callResult === true;

const cloudflareImportedFactoryMemberStep = (
  program,
  factoryCall,
  bindings,
  returnedPath
) => {
  const member = cloudflareMemberName(factoryCall);
  if (member === undefined) return undefined;
  return cloudflareImportedFactoryCall(program, factoryCall.object, bindings, [
    member,
    ...returnedPath,
  ]);
};

const cloudflareImportedFactoryCallStep = (
  program,
  factoryCall,
  bindings,
  returnedPath
) => {
  const imported = directImportedCloudflareInvocation(
    program,
    factoryCall.callee,
    bindings
  );
  const callableArguments = factoryCall.arguments.flatMap((argument, index) =>
    nodeType(argument) !== 'SpreadElement' &&
    isCloudflareFunctionNode(resolveCloudflareTarget(argument, bindings))
      ? [{ argument, index }]
      : []
  );
  const factoryArgumentOrigins = factoryCall.arguments.flatMap(
    (argument, index) => {
      if (nodeType(argument) === 'SpreadElement') return [];
      const invocation = importedCloudflareFactoryResultInvocation(
        program,
        argument,
        bindings
      );
      return invocation
        ? [
            {
              index,
              invocation: cloudflareSerializableImportedInvocation(invocation),
            },
          ]
        : [];
    }
  );
  const resolvedArgumentIndexes = factoryCall.arguments.flatMap(
    (argument, index) =>
      nodeType(argument) !== 'SpreadElement' &&
      (cloudflareStructuralArgumentCandidateTypes.has(
        nodeType(resolveCloudflareTarget(argument, bindings))
      ) ||
        importedCloudflareFactoryResultInvocation(
          program,
          argument,
          bindings
        ) !== undefined)
        ? [index]
        : []
  );
  return imported
    ? {
        factoryArgumentCount: factoryCall.arguments.every(
          (argument) => nodeType(argument) !== 'SpreadElement'
        )
          ? factoryCall.arguments.length
          : undefined,
        factoryArgumentOrigins,
        factoryCallKey: cloudflareNodeSemanticKey(factoryCall),
        factoryCallableArgumentIndexes: callableArguments.map(
          ({ index }) => index
        ),
        factoryCallableArguments: callableArguments.map(
          ({ argument }) => argument
        ),
        factoryResolvedArgumentIndexes: resolvedArgumentIndexes,
        imported,
        returnedPath,
      }
    : cloudflareImportedFactoryCall(program, factoryCall.callee, bindings, [
        cloudflareReturnedCallProjection,
        ...returnedPath,
      ]);
};

const cloudflareImportedFactoryConstructStep = (
  program,
  factoryCall,
  bindings,
  returnedPath
) => {
  const imported = directImportedCloudflareInvocation(
    program,
    factoryCall.callee,
    bindings
  );
  return imported ? { imported, returnedPath } : undefined;
};

const cloudflareImportedFactoryTaggedStep = (
  program,
  factoryCall,
  bindings,
  returnedPath
) => {
  const imported = directImportedCloudflareInvocation(
    program,
    factoryCall.tag,
    bindings
  );
  return imported ? { imported, returnedPath } : undefined;
};

const cloudflareImportedFactoryStepReaders = {
  CallExpression: cloudflareImportedFactoryCallStep,
  MemberExpression: cloudflareImportedFactoryMemberStep,
  NewExpression: cloudflareImportedFactoryConstructStep,
  TaggedTemplateExpression: cloudflareImportedFactoryTaggedStep,
};

function cloudflareImportedFactoryCall(
  program,
  target,
  bindings,
  returnedPath = []
) {
  assert(
    returnedPath.length <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  const factoryCall = cloudflareCallableTarget(target, bindings);
  const reader = cloudflareImportedFactoryStepReaders[nodeType(factoryCall)];
  return reader
    ? reader(program, factoryCall, bindings, returnedPath)
    : undefined;
}

const importedCloudflareFactoryResultInvocation = (
  program,
  target,
  bindings
) => {
  const result = cloudflareImportedFactoryCall(program, target, bindings);
  if (!result) return undefined;
  return {
    ...result.imported,
    factoryArgumentCount: result.factoryArgumentCount,
    factoryArgumentOrigins: result.factoryArgumentOrigins,
    factoryCallKey: result.factoryCallKey,
    factoryCallableArgumentIndexes: result.factoryCallableArgumentIndexes,
    factoryCallableArguments: result.factoryCallableArguments,
    factoryResolvedArgumentIndexes: result.factoryResolvedArgumentIndexes,
    returnedPath: result.returnedPath,
  };
};

const importedCloudflareInvocation = (program, target, bindings) =>
  directImportedCloudflareInvocation(program, target, bindings) ??
  importedCloudflareFactoryResultInvocation(program, target, bindings);

const cloudflareKeyValue = (value, fallback) =>
  [undefined, null].includes(value) ? fallback : value;

const cloudflareImportedArgumentOriginKey = (origin) => ({
  index: origin.index,
  invocation: origin.invocation,
  localFunctionKeys: origin.localFunctionKeys
    ? [...origin.localFunctionKeys].toSorted(compareCodePointStrings)
    : undefined,
});

const cloudflareImportedInvocationKey = (imported) =>
  `${imported.localName}\0${imported.importedName}\0${JSON.stringify({
    callerAnalysisLabel: cloudflareKeyValue(imported.callerAnalysisLabel, null),
    factoryArgumentCount: cloudflareKeyValue(
      imported.factoryArgumentCount,
      null
    ),
    factoryArgumentOrigins: cloudflareKeyValue(
      imported.factoryArgumentOrigins,
      null
    ),
    factoryCallKey: cloudflareKeyValue(imported.factoryCallKey, null),
    factoryCaptureResolutionProven: cloudflareKeyValue(
      imported.factoryCaptureResolutionProven,
      false
    ),
    deferredArgumentHazardIndexes: cloudflareKeyValue(
      imported.deferredArgumentHazardIndexes,
      null
    ),
    factoryCallableArgumentIndexes: cloudflareKeyValue(
      imported.factoryCallableArgumentIndexes,
      null
    ),
    factoryResolvedArgumentIndexes: cloudflareKeyValue(
      imported.factoryResolvedArgumentIndexes,
      null
    ),
    localCallableArgumentOrigins: cloudflareKeyValue(
      imported.localCallableArgumentOrigins?.map(
        cloudflareImportedArgumentOriginKey
      ),
      null
    ),
    opaqueArgumentIndexes: cloudflareKeyValue(
      imported.opaqueArgumentIndexes,
      null
    ),
    opaqueArgumentOrigins: cloudflareKeyValue(
      imported.opaqueArgumentOrigins?.map(cloudflareImportedArgumentOriginKey),
      null
    ),
    returnedPath: cloudflareKeyValue(imported.returnedPath, null),
  })}`;

const cloudflareReturnedPathSuffixes = (returnedPath) =>
  returnedPath.map((_, index) => returnedPath.slice(index));

const recordCloudflareImportedFactoryCaptureExecutions = (
  imported,
  context
) => {
  const callableArguments = imported.factoryCallableArguments ?? [];
  if (callableArguments.length === 0) return false;
  const suffixes = cloudflareReturnedPathSuffixes(imported.returnedPath ?? []);
  let resolvedReturnedCandidates = 0;
  callableArguments.forEach((argument) =>
    cloudflareLexicalTargetCandidates(
      argument,
      argument,
      context.lexicalContext
    )
      .filter(({ target }) => isCloudflareFunctionNode(target))
      .forEach((candidate) => {
        recordCloudflareExecutionCandidate(candidate, context);
        cloudflareFunctionReturnExpressions(candidate.target).forEach(
          (returned) =>
            suffixes.forEach((suffix) => {
              const target = cloudflareReturnedInvocationTarget(
                returned,
                suffix
              );
              cloudflareLexicalTargetCandidates(
                target,
                target,
                context.lexicalContext
              ).forEach((returnedCandidate) => {
                resolvedReturnedCandidates += 1;
                recordCloudflareExecutionCandidate(returnedCandidate, context);
              });
            })
        );
      })
  );
  return resolvedReturnedCandidates > 0;
};

const recordCloudflareExecutionOwner = (target, owner, context, execution) => {
  if (owner) {
    context.addInvoked(owner);
    return;
  }
  const imported = importedCloudflareInvocation(
    context.program,
    target,
    context.bindings
  );
  if (imported) {
    imported.callerAnalysisLabel = context.lexicalContext.analysisLabel;
    if (execution) {
      const argumentProfile = cloudflareArgumentProfile(execution, context);
      imported.deferredArgumentHazardIndexes =
        argumentProfile.deferredArgumentHazardIndexes;
      imported.opaqueArgumentIndexes = argumentProfile.opaqueArgumentIndexes;
      imported.opaqueArgumentOrigins = argumentProfile.opaqueArgumentOrigins;
      imported.localCallableArgumentOrigins =
        argumentProfile.localCallableArgumentOrigins;
    }
    imported.factoryCaptureResolutionProven =
      recordCloudflareImportedFactoryCaptureExecutions(imported, context);
    context.importedInvocations.set(
      cloudflareImportedInvocationKey(imported),
      imported
    );
  }
};

const cloudflareNodeSemanticKey = (node) => {
  const positioned = [
    Number.isInteger(node?.start),
    Number.isInteger(node?.end),
  ].every(Boolean);
  return positioned
    ? `${nodeType(node)}@${String(node.start)}:${String(node.end)}`
    : `${nodeType(node)}#${astDigest(node)}`;
};

const cloudflareCandidateSemanticValue = (
  candidate,
  memo = new WeakMap(),
  active = new WeakSet(),
  depth = 0
) => {
  assert(
    depth <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  const cached = memo.get(candidate);
  if (cached) return cached;
  if (active.has(candidate)) {
    return { cycle: cloudflareNodeSemanticKey(candidate.target) };
  }
  active.add(candidate);
  const value = {
    accessorOwners: candidate.accessorOwners?.map((owner) =>
      cloudflareCandidateSemanticKey(owner, memo, active, depth + 1)
    ),
    boundArguments: candidate.boundArguments?.map(cloudflareNodeSemanticKey),
    boundThisValue: candidate.boundThisValue
      ? cloudflareNodeSemanticKey(candidate.boundThisValue)
      : undefined,
    factoryBindings: [...(candidate.factoryBindings?.entries() ?? [])].map(
      ([name, candidates]) => [
        name,
        candidates.map((child) =>
          cloudflareCandidateSemanticKey(child, memo, active, depth + 1)
        ),
      ]
    ),
    invocationKind: candidate.invocationKind,
    parameterName: candidate.parameterName,
    parameterPath: candidate.parameterPath,
    safeFalsyShortCircuit: candidate.safeFalsyShortCircuit === true,
    target: cloudflareNodeSemanticKey(candidate.target),
  };
  active.delete(candidate);
  const digest = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
  memo.set(candidate, digest);
  return digest;
};

const cloudflareCandidateSemanticKey = (
  candidate,
  memo = new WeakMap(),
  active = new WeakSet(),
  depth = 0
) => cloudflareCandidateSemanticValue(candidate, memo, active, depth);

const addCloudflareFactoryBindingCandidates = (
  existing,
  existingKeys,
  name,
  candidates
) => {
  const keys = existingKeys.get(name) ?? new Set();
  const values = existing.get(name) ?? [];
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = cloudflareCandidateSemanticKey(candidate);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  existing.set(name, [...values, ...uniqueCandidates]);
  existingKeys.set(name, keys);
  return uniqueCandidates.length;
};

const recordCloudflareExecutionCandidate = (candidate, context, execution) => {
  (candidate.accessorOwners ?? []).forEach((owner) =>
    recordCloudflareExecutionCandidate(
      { ...owner, accessorOwners: undefined },
      context
    )
  );
  const bindingsChanged = recordCloudflareCandidateFactoryBindings(
    candidate,
    context
  );
  recordCloudflareExecutionOwner(
    candidate.target,
    isCloudflareFunctionNode(candidate.target) ? candidate.target : undefined,
    context,
    execution
  );
  if (bindingsChanged) context.addInvoked(candidate.target, true);
};

const cloudflareFactoryBindingMaps = (candidate, lexicalContext) => ({
  existing:
    lexicalContext.factoryBindingsByFunction.get(candidate.target) ?? new Map(),
  existingKeys:
    lexicalContext.factoryBindingKeysByFunction.get(candidate.target) ??
    new Map(),
});

const updateCloudflareFactoryBindingRevision = (
  candidate,
  additions,
  lexicalContext
) => {
  if (additions === 0) return;
  lexicalContext.factoryBindingEpoch += 1;
  const revisions = lexicalContext.factoryBindingRevisionByFunction;
  revisions.set(candidate.target, (revisions.get(candidate.target) ?? 0) + 1);
};

const recordCloudflareCandidateFactoryBindings = (candidate, context) => {
  const factoryBindings = isCloudflareFunctionNode(candidate.target)
    ? candidate.factoryBindings
    : undefined;
  if (!factoryBindings) return false;
  const lexicalContext = context.lexicalContext;
  const { existing, existingKeys } = cloudflareFactoryBindingMaps(
    candidate,
    lexicalContext
  );
  let additions = 0;
  factoryBindings.forEach((candidates, name) => {
    additions += addCloudflareFactoryBindingCandidates(
      existing,
      existingKeys,
      name,
      candidates
    );
  });
  lexicalContext.factoryBindingsByFunction.set(candidate.target, existing);
  lexicalContext.factoryBindingKeysByFunction.set(
    candidate.target,
    existingKeys
  );
  updateCloudflareFactoryBindingRevision(candidate, additions, lexicalContext);
  return additions > 0;
};

const cloudflareStructuralArgumentCandidateTypes = new Set([
  'ArrayExpression',
  'Literal',
  'ObjectExpression',
  'TemplateLiteral',
]);

const cloudflareSerializableImportedInvocation = (invocation) => ({
  callerAnalysisLabel: invocation.callerAnalysisLabel,
  deferredArgumentHazardIndexes: invocation.deferredArgumentHazardIndexes,
  factoryArgumentCount: invocation.factoryArgumentCount,
  factoryArgumentOrigins: invocation.factoryArgumentOrigins,
  factoryCallKey: invocation.factoryCallKey,
  factoryCallableArgumentIndexes: invocation.factoryCallableArgumentIndexes,
  factoryResolvedArgumentIndexes: invocation.factoryResolvedArgumentIndexes,
  importedName: invocation.importedName,
  localName: invocation.localName,
  returnedPath: invocation.returnedPath,
  source: invocation.source,
});

const cloudflareImportedFactoryOriginTargets = (
  execution,
  source,
  candidates,
  lexicalContext
) => {
  const binding =
    nodeType(source) === 'Identifier'
      ? artifactOwnerLexicalBinding(execution, source.name, lexicalContext)
      : undefined;
  const bindingValues = binding
    ? cloudflareLexicalBindingValues(binding, source.name, lexicalContext)
    : [];
  return [source, ...bindingValues, ...candidates.map(({ target }) => target)];
};

const cloudflareNestedCallableCandidates = (
  node,
  candidate,
  lexicalContext,
  seen = new Set(),
  depth = 0
) => {
  assert(
    depth <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  if (isCloudflareFunctionNode(candidate.target)) return [candidate];
  if (seen.has(candidate.target)) return [];
  const nextSeen = new Set(seen).add(candidate.target);
  const values = cloudflareWildcardMemberValues(candidate.target);
  if (!values) return [];
  return values.flatMap((value) =>
    cloudflareLexicalTargetCandidates(
      node,
      value,
      lexicalContext,
      nextSeen
    ).flatMap((child) =>
      cloudflareNestedCallableCandidates(
        node,
        inheritCloudflareCandidateContext(candidate, child),
        lexicalContext,
        nextSeen,
        depth + 1
      )
    )
  );
};

const cloudflareStructuralDescendants = (target, seen = new Set()) => {
  const descendants = [];
  const visited = new Set(seen);
  const pending = [{ depth: 0, target }];
  let work = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    assert(
      current.depth <= cloudflareFactoryResolutionLimit,
      cloudflareFactoryResolutionMessage
    );
    if (visited.has(current.target)) continue;
    visited.add(current.target);
    descendants.push(current.target);
    const values = cloudflareWildcardMemberValues(current.target) ?? [];
    work += values.length;
    assert(work <= cloudflareAnalysisWorkLimit, cloudflareAnalysisWorkMessage);
    values.forEach((value) =>
      pending.push({ depth: current.depth + 1, target: value })
    );
  }
  return descendants;
};

const cloudflareArgumentCandidatesAreOpaque = (
  source,
  candidates,
  directCallableCandidates,
  nestedCallableCandidates
) => {
  const onlySymbolicParameters =
    candidates.length > 0 &&
    candidates.every(({ parameterName }) => parameterName !== undefined);
  if (onlySymbolicParameters) return false;
  const sourceIsStructural = cloudflareStructuralArgumentCandidateTypes.has(
    nodeType(source)
  );
  const hasOpaqueCandidate = candidates.some(
    ({ target }) =>
      !isCloudflareFunctionNode(target) &&
      !cloudflareStructuralArgumentCandidateTypes.has(nodeType(target))
  );
  return [
    candidates.length === 0 && !sourceIsStructural,
    directCallableCandidates.length > 0,
    nestedCallableCandidates.length > 0,
    hasOpaqueCandidate,
  ].includes(true);
};

const cloudflareRecordImportedArgumentOrigins = (
  execution,
  source,
  index,
  candidates,
  context,
  opaqueArgumentOrigins
) => {
  const originKeys = new Set();
  cloudflareImportedFactoryOriginTargets(
    execution,
    source,
    candidates,
    context.lexicalContext
  )
    .flatMap((target) => cloudflareStructuralDescendants(target))
    .forEach((target) => {
      const origin = importedCloudflareFactoryResultInvocation(
        context.program,
        target,
        context.bindings
      );
      if (!origin) return;
      origin.callerAnalysisLabel = context.lexicalContext.analysisLabel;
      const originKey = cloudflareImportedInvocationKey(origin);
      if (originKeys.has(originKey)) return;
      originKeys.add(originKey);
      opaqueArgumentOrigins.push({
        callableParameterProgram: context.program,
        callableParameterSources: origin.factoryCallableArguments ?? [],
        index,
        invocation: cloudflareSerializableImportedInvocation(origin),
      });
    });
};

const cloudflareCallableCandidatesHaveSafeParameters = (candidates, context) =>
  candidates.length > 0 &&
  candidates.every(
    ({ target }) =>
      isCloudflareFunctionNode(target) &&
      cloudflareInvokedParameterProjections(
        target,
        context.program,
        context.lexicalContext
      ).length === 0
  );

const cloudflareDeferredImportedFactoryResultCandidates = (source, context) => {
  if (
    !context.lexicalContext.artifactRoot ||
    !context.lexicalContext.chunkFile
  ) {
    return [];
  }
  const invocation = importedCloudflareFactoryResultInvocation(
    context.program,
    source,
    context.bindings
  );
  if (!invocation?.source?.startsWith('./')) return [];
  const ownerFile = path.resolve(
    path.dirname(context.lexicalContext.chunkFile),
    invocation.source
  );
  if (!isWithinDirectory(ownerFile, context.lexicalContext.artifactRoot)) {
    return [];
  }
  const manifestRecord = assertCloudflareChunkManifestMembership(
    context.lexicalContext.artifactRoot,
    ownerFile,
    'deferred factory result owner'
  );
  cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord);
  const ownerProgram = readParsedModule(ownerFile).program;
  const ownerLocalName = new Map(
    ownerProgram.body.flatMap(moduleExportEntries)
  ).get(invocation.importedName);
  if (typeof ownerLocalName !== 'string') return [];
  const lexicalContext = createCloudflareLexicalContext(
    ownerProgram,
    normalizeArtifactFile(context.lexicalContext.artifactRoot, ownerFile)
  );
  const factory = resolveCloudflareTarget(
    { name: ownerLocalName, type: 'Identifier' },
    lexicalContext.topLevelBindings
  );
  if (!isCloudflareFunctionNode(factory)) return [];
  return cloudflareFunctionReturnExpressions(factory).flatMap((returned) => {
    const target = cloudflareReturnedInvocationTarget(
      returned,
      invocation.returnedPath ?? []
    );
    return cloudflareLexicalTargetCandidates(target, target, lexicalContext);
  });
};

const cloudflareDeferredObjectHazardTargets = (target) => {
  const hazard = target.properties.some(
    (property) =>
      nodeType(property) === 'SpreadElement' ||
      new Set(['get', 'set']).has(property.kind)
  );
  return hazard
    ? { hazard: true, targets: [] }
    : {
        hazard: false,
        targets: target.properties.map((property) => property.value),
      };
};

const cloudflareDeferredArgumentHazardTargets = (target, context) => {
  if (nodeType(target) === 'CallExpression') {
    const returned = cloudflareDeferredImportedFactoryResultCandidates(
      target,
      context
    );
    return returned.length === 0
      ? { hazard: true, targets: [] }
      : {
          hazard: false,
          targets: returned.map((candidate) => candidate.target),
        };
  }
  if (nodeType(target) === 'ObjectExpression') {
    return cloudflareDeferredObjectHazardTargets(target);
  }
  if (nodeType(target) === 'ArrayExpression') {
    return { hazard: false, targets: target.elements.filter(Boolean) };
  }
  return {
    hazard: new Set(['NewExpression', 'TaggedTemplateExpression']).has(
      nodeType(target)
    ),
    targets: [],
  };
};

const cloudflareBoundedTargetSome = (target, inspect, budget = { work: 0 }) => {
  const pending = [target];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    budget.work += 1;
    assert(
      budget.work <= cloudflareAnalysisWorkLimit,
      cloudflareAnalysisWorkMessage
    );
    const next = inspect(current);
    if (next.match) return true;
    const targets = next.targets ?? [];
    assert(
      budget.work + pending.length + targets.length <=
        cloudflareAnalysisWorkLimit,
      cloudflareAnalysisWorkMessage
    );
    targets.forEach((nextTarget) => pending.push(nextTarget));
  }
  return false;
};

const cloudflareDeferredArgumentTargetHasHazard = (target, context) =>
  cloudflareBoundedTargetSome(target, (current) => {
    if (isCloudflareFunctionNode(current)) return { targets: [] };
    if (isCloudflareDirectProxyConstruction(current, context.lexicalContext)) {
      return { match: true, targets: [] };
    }
    const next = cloudflareDeferredArgumentHazardTargets(current, context);
    return { match: next.hazard, targets: next.targets };
  });

export const inspectCloudflareDeferredArgumentHazardForTesting = (
  source,
  bindingName
) => {
  const program = parseModuleSource(
    'deferred-argument.fixture.js',
    source
  ).program;
  const bindings = cloudflareTopLevelBindings(program);
  const target = bindings.get(bindingName);
  assert(target, `missing deferred-argument fixture binding ${bindingName}`);
  return cloudflareDeferredArgumentTargetHasHazard(target, {
    bindings,
    lexicalContext: createCloudflareLexicalContext(
      program,
      'deferred-argument.fixture.js'
    ),
    program,
  });
};

const cloudflareDeferredArgumentHasHazard = (source, candidates, context) => {
  if (
    nodeType(source) === 'Identifier' &&
    !cloudflareReturnedOwnersAreUnmutated(context.program, [source.name])
  ) {
    return true;
  }
  const targets =
    candidates.length > 0 ? candidates.map(({ target }) => target) : [source];
  if (
    targets.every((target) =>
      new Set(['Identifier', 'MemberExpression']).has(nodeType(target))
    )
  ) {
    return true;
  }
  return targets.some((target) =>
    cloudflareDeferredArgumentTargetHasHazard(target, context)
  );
};

const cloudflareRecordArgumentProfileEntry = (
  execution,
  source,
  index,
  context,
  profile
) => {
  assert(
    nodeType(source) !== 'SpreadElement',
    `${cloudflareOpaqueSpreadArgumentsMessage} in ${context.lexicalContext.analysisLabel} (${nodeType(execution)}@${String(execution.start)}:${String(execution.end)})`
  );
  const candidates = cloudflareSourceCandidates(
    execution,
    source,
    context.lexicalContext
  );
  const directCallableCandidates = candidates.filter(({ target }) =>
    isCloudflareFunctionNode(target)
  );
  profile.callableCandidates.push(...directCallableCandidates);
  const nestedCallableCandidates = candidates
    .filter(({ target }) => !isCloudflareFunctionNode(target))
    .flatMap((candidate) =>
      cloudflareNestedCallableCandidates(
        execution,
        candidate,
        context.lexicalContext
      )
    );
  const localFunctionKeys = [
    ...new Set(
      [...directCallableCandidates, ...nestedCallableCandidates].map(
        ({ target }) => cloudflareNodeSemanticKey(target)
      )
    ),
  ];
  if (localFunctionKeys.length > 0) {
    profile.localCallableArgumentOrigins.push({
      callableParameterCandidates: [
        ...directCallableCandidates,
        ...nestedCallableCandidates,
      ],
      callableParameterProgram: context.program,
      index,
      localFunctionKeys,
    });
  }
  if (cloudflareDeferredArgumentHasHazard(source, candidates, context)) {
    profile.deferredArgumentHazardIndexes.push(index);
  }
  if (
    !cloudflareArgumentCandidatesAreOpaque(
      source,
      candidates,
      directCallableCandidates,
      nestedCallableCandidates
    )
  ) {
    return;
  }
  profile.opaqueArgumentIndexes.push(index);
  cloudflareRecordImportedArgumentOrigins(
    execution,
    source,
    index,
    candidates,
    context,
    profile.opaqueArgumentOrigins
  );
};

const cloudflareArgumentProfile = (execution, context) => {
  const cached = context.importedArgumentProfiles?.get(execution);
  if (cached?.epoch === context.lexicalContext.factoryBindingEpoch) {
    return cached.profile;
  }
  const profile = {
    callableCandidates: [],
    deferredArgumentHazardIndexes: [],
    localCallableArgumentOrigins: [],
    opaqueArgumentIndexes: [],
    opaqueArgumentOrigins: [],
  };
  cloudflareExecutionArguments(
    execution,
    undefined,
    context.lexicalContext
  ).forEach((source, index) =>
    cloudflareRecordArgumentProfileEntry(
      execution,
      source,
      index,
      context,
      profile
    )
  );
  context.importedArgumentProfiles ??= new WeakMap();
  context.importedArgumentProfiles.set(execution, {
    epoch: context.lexicalContext.factoryBindingEpoch,
    profile,
  });
  return profile;
};

const importedCloudflareExecution = (execution, context) =>
  importedCloudflareInvocation(
    context.program,
    execution.callee ?? execution.tag,
    context.bindings
  );

const cloudflareSourceHasUnboundOwnerParameter = (
  execution,
  source,
  lexicalContext
) => {
  const owner = cloudflareFunctionOwnerAt(execution, lexicalContext);
  if (!isCloudflareFunctionNode(owner)) return false;
  const boundParameters =
    lexicalContext.factoryBindingsByFunction.get(owner) ?? new Map();
  const sourceNames = freeIdentifierNames(source);
  return cloudflareParameterEntries(owner).some(
    ({ name }) => sourceNames.has(name) && !boundParameters.has(name)
  );
};

const cloudflareBoundRestSpreadCandidates = (
  execution,
  source,
  lexicalContext
) => {
  if (nodeType(source) !== 'SpreadElement') return undefined;
  const owner = cloudflareFunctionOwnerAt(execution, lexicalContext);
  if (!isCloudflareFunctionNode(owner)) return undefined;
  const name = identifierName(source.argument);
  const restParameter = cloudflareParameterEntries(owner).find(
    (entry) =>
      entry.name === name && nodeType(entry.parameter) === 'RestElement'
  );
  if (!restParameter) return undefined;
  return cloudflareSourceCandidates(execution, source.argument, lexicalContext);
};

const recordCloudflareExecutionArguments = (
  execution,
  ownerCandidates,
  context
) => {
  if (isCloudflareUnshadowedObjectAssign(execution, context)) return;
  const isImportedWithoutOwners = [
    ownerCandidates.length === 0,
    Boolean(importedCloudflareExecution(execution, context)),
  ].every(Boolean);
  if (isImportedWithoutOwners) {
    cloudflareArgumentProfile(execution, context);
    return;
  }
  const invokedCandidates =
    ownerCandidates.length === 0
      ? cloudflareExecutionArguments(
          execution,
          undefined,
          context.lexicalContext
        ).flatMap((source) => {
          if (
            cloudflareSourceHasUnboundOwnerParameter(
              execution,
              source,
              context.lexicalContext
            )
          ) {
            return [];
          }
          const restCandidates = cloudflareBoundRestSpreadCandidates(
            execution,
            source,
            context.lexicalContext
          );
          if (restCandidates) return restCandidates;
          assert(
            nodeType(source) !== 'SpreadElement',
            `${cloudflareOpaqueSpreadArgumentsMessage} during execution propagation in ${context.lexicalContext.analysisLabel} (${nodeType(execution)}@${String(execution.start)}:${String(execution.end)})`
          );
          return cloudflareSourceCandidates(
            execution,
            source,
            context.lexicalContext
          );
        })
      : ownerCandidates.flatMap((ownerCandidate) =>
          cloudflareInvokedParameterProjections(
            ownerCandidate.target,
            context.program,
            context.lexicalContext
          ).flatMap((projection) =>
            cloudflareParameterExecutionCandidates(
              ownerCandidate.target,
              execution,
              projection,
              context.lexicalContext,
              ownerCandidate
            )
          )
        );
  invokedCandidates.forEach((candidate) =>
    recordCloudflareExecutionCandidate(candidate, context)
  );
};

const isCloudflareNamedMemberExecution = (
  target,
  ownerName,
  memberName,
  bindings
) => {
  const resolved = cloudflareCallableTarget(target, bindings);
  return [
    nodeType(resolved) === 'MemberExpression',
    identifierName(resolved?.object) === ownerName,
    cloudflareMemberName(resolved) === memberName,
  ].every(Boolean);
};

const cloudflareObjectAssignArguments = (execution, context) => {
  if (nodeType(execution) !== 'CallExpression') return undefined;
  return cloudflareUnshadowedObjectAssignArguments(
    execution,
    context.lexicalContext
  );
};

const cloudflareObjectAssignSources = (execution, context) =>
  cloudflareObjectAssignArguments(execution, context)?.slice(1);

const isCloudflareUnshadowedObjectAssign = (execution, context) =>
  cloudflareObjectAssignSources(execution, context) !== undefined;

const cloudflareObjectAssignPropertyAccess = (target, property) => {
  const member = propertyKeyName(property);
  return member === undefined
    ? {
        computed: true,
        object: target,
        property: property.key,
        type: 'MemberExpression',
      }
    : cloudflareProjectionMember(target, member);
};

const recordCloudflareObjectAssignAccessors = (execution, context) => {
  const arguments_ = cloudflareObjectAssignArguments(execution, context);
  if (!arguments_ || arguments_.length === 0) return;
  const [target, ...sources] = arguments_;
  sources.forEach((source) =>
    cloudflareLexicalTargetCandidates(execution, source, context.lexicalContext)
      .filter(({ target }) => nodeType(target) === 'ObjectExpression')
      .forEach((candidate) =>
        candidate.target.properties
          .filter(({ kind }) => kind === 'get')
          .forEach((getter) =>
            recordCloudflareExecutionCandidate(
              {
                factoryBindings: candidate.factoryBindings,
                target: getter.value,
              },
              context
            )
          )
      )
  );
  sources.forEach((source) =>
    cloudflareLexicalTargetCandidates(execution, source, context.lexicalContext)
      .filter(({ target: candidate }) =>
        new Set(['ArrayExpression', 'ObjectExpression']).has(
          nodeType(candidate)
        )
      )
      .flatMap(({ target: candidate }) =>
        nodeType(candidate) === 'ArrayExpression'
          ? candidate.elements.flatMap((value, index) =>
              value ? [cloudflareProjectionMember(target, index)] : []
            )
          : candidate.properties.map((property) =>
              cloudflareObjectAssignPropertyAccess(target, property)
            )
      )
      .forEach((access) => {
        context.lexicalContext.accessorAccessKinds.set(access, 'set');
        recordCloudflareAccessorRead(access, context);
      })
  );
};

const cloudflareReflectSetMember = (execution) => {
  const [object, property] = execution.arguments;
  const member = cloudflareLiteralMemberName(property);
  assert(
    member !== undefined,
    'Cloudflare load-effect analysis requires a static Reflect.set property'
  );
  return cloudflareProjectionMember(object, member);
};

const recordCloudflareReflectSetAccessor = (execution, context) => {
  if (
    !isCloudflareNamedMemberExecution(
      execution.callee,
      'Reflect',
      'set',
      context.bindings
    )
  ) {
    return;
  }
  const member = cloudflareReflectSetMember(execution);
  context.lexicalContext.accessorAccessKinds.set(member, 'set');
  recordCloudflareAccessorRead(member, context);
};

const recordCloudflareImplicitAccessorExecutions = (execution, context) => {
  if (nodeType(execution) !== 'CallExpression') return;
  recordCloudflareObjectAssignAccessors(execution, context);
  recordCloudflareReflectSetAccessor(execution, context);
};

const cloudflareGeneratorNextIsConsumed = (execution, parent, grandparent) =>
  [
    nodeType(parent) === 'MemberExpression',
    parent?.object === execution,
    cloudflareMemberName(parent) === 'next',
    nodeType(grandparent) === 'CallExpression',
    grandparent?.callee === parent,
  ].every(Boolean);

const cloudflareGeneratorLoopIsConsumed = (execution, parent) =>
  nodeType(parent) === 'ForOfStatement' && parent.right === execution;

const cloudflareGeneratorPatternIsConsumed = (parent) =>
  new Set(['ArrayPattern', 'ObjectPattern']).has(
    nodeType(parent?.id ?? parent?.left)
  );

const cloudflareGeneratorCreationIsConsumed = (execution, lexicalContext) => {
  const parent = lexicalContext.parentNodes.get(execution);
  const grandparent = lexicalContext.parentNodes.get(parent);
  return [
    cloudflareGeneratorNextIsConsumed(execution, parent, grandparent),
    cloudflareGeneratorLoopIsConsumed(execution, parent),
    cloudflareGeneratorPatternIsConsumed(parent),
  ].includes(true);
};

const cloudflareActiveExecutionCandidate = (
  execution,
  candidate,
  lexicalContext
) =>
  !(
    nodeType(execution) === 'CallExpression' &&
    candidate.target?.generator === true &&
    !cloudflareGeneratorCreationIsConsumed(execution, lexicalContext)
  );

const cloudflareNextGeneratorOwners = (execution, lexicalContext) => {
  const nextTarget = execution.callee;
  if (
    nodeType(execution) !== 'CallExpression' ||
    nodeType(nextTarget) !== 'MemberExpression' ||
    cloudflareMemberName(nextTarget) !== 'next'
  ) {
    return [];
  }
  return cloudflareLexicalTargetCandidates(
    execution,
    nextTarget.object,
    lexicalContext
  )
    .map(({ target }) => target)
    .filter((target) => nodeType(target) === 'CallExpression')
    .flatMap((generatorCall) =>
      cloudflareLexicalTargetCandidates(
        execution,
        generatorCall.callee,
        lexicalContext
      )
    )
    .filter(
      ({ target }) => isCloudflareFunctionNode(target) && target.generator
    );
};

const cloudflareSuperClassAt = (execution, context) => {
  const isSuperCall = [
    nodeType(execution) === 'CallExpression',
    nodeType(execution.callee) === 'Super',
  ].every(Boolean);
  if (!isSuperCall) return undefined;
  const classNode = findCloudflareEnclosingClass(
    execution,
    context.lexicalContext
  );
  if (!classNode) return undefined;
  return classNode.superClass;
};

const recordCloudflareImportedClassInvocation = (
  target,
  argumentNodes,
  context
) => {
  const imported = directImportedCloudflareInvocation(
    context.program,
    target,
    context.bindings
  );
  if (!imported) return false;
  imported.callerAnalysisLabel = context.lexicalContext.analysisLabel;
  imported.factoryArgumentCount = argumentNodes.every(
    (argument) => nodeType(argument) !== 'SpreadElement'
  )
    ? argumentNodes.length
    : undefined;
  imported.returnedPath = [];
  context.importedInvocations.set(
    cloudflareImportedInvocationKey(imported),
    imported
  );
  return true;
};

const recordCloudflareImportedSuperConstructor = (execution, context) => {
  const superClass = cloudflareSuperClassAt(execution, context);
  if (!superClass) return;
  recordCloudflareImportedClassInvocation(
    superClass,
    execution.arguments,
    context
  );
};

const cloudflareProxyConstructionIsObserved = (execution, lexicalContext) => {
  const parent = lexicalContext.parentNodes.get(execution);
  return ![
    nodeType(parent) === 'ExpressionStatement',
    parent?.expression === execution,
  ].every(Boolean);
};

const recordCloudflareObservedProxyTraps = (execution, context) => {
  const lexicalContext = context.lexicalContext;
  const shouldActivate = [
    isCloudflareDirectProxyConstruction(execution, lexicalContext),
    cloudflareProxyConstructionIsObserved(execution, lexicalContext),
  ].every(Boolean);
  if (!shouldActivate) return;
  cloudflareDirectProxyHandlerCandidates(
    execution,
    execution,
    lexicalContext,
    new Set()
  )
    .flatMap(({ target: handler }) => handler.properties)
    .map(({ value }) => value)
    .filter(isCloudflareFunctionNode)
    .forEach((trap) => context.addInvoked(trap));
};

const recordCloudflareImplicitImportedSuperConstructor = (
  execution,
  classNode,
  context,
  seen = new Set()
) => {
  if (seen.has(classNode)) return;
  if (cloudflareClassConstructor(classNode) || !classNode.superClass) return;
  if (
    recordCloudflareImportedClassInvocation(
      classNode.superClass,
      execution.arguments,
      context
    )
  ) {
    return;
  }
  const nextSeen = new Set(seen).add(classNode);
  cloudflareLexicalTargetCandidates(
    execution,
    classNode.superClass,
    context.lexicalContext,
    nextSeen
  )
    .filter(({ target }) => isCloudflareClassNode(target))
    .forEach(({ target }) =>
      recordCloudflareImplicitImportedSuperConstructor(
        execution,
        target,
        context,
        nextSeen
      )
    );
};

const recordCloudflareExecution = (execution, target, context) => {
  recordCloudflareImplicitAccessorExecutions(execution, context);
  recordCloudflareImportedSuperConstructor(execution, context);
  recordCloudflareObservedProxyTraps(execution, context);
  cloudflareNextGeneratorOwners(execution, context.lexicalContext).forEach(
    (candidate) => recordCloudflareExecutionCandidate(candidate, context)
  );
  const importedExecution = importedCloudflareExecution(execution, context);
  if (importedExecution) {
    recordCloudflareExecutionOwner(target, undefined, context, execution);
    return;
  }
  const resolvedCandidates = cloudflareLexicalTargetCandidates(
    execution,
    target,
    context.lexicalContext
  );
  if (nodeType(execution) === 'NewExpression') {
    const constructedClasses = resolvedCandidates.filter(
      ({ target: candidate }) => isCloudflareClassNode(candidate)
    );
    constructedClasses.forEach(({ target: classNode }) =>
      recordCloudflareImplicitImportedSuperConstructor(
        execution,
        classNode,
        context
      )
    );
    constructedClasses
      .flatMap(({ target: classNode }) =>
        cloudflareClassLineage(
          execution,
          classNode,
          context.lexicalContext,
          new Set()
        )
      )
      .forEach((classNode) => context.addInvoked(classNode));
  }
  const candidates = resolvedCandidates.flatMap((candidate) => {
    const constructors = cloudflareExecutionConstructors(
      execution,
      candidate.target,
      context.lexicalContext
    );
    return constructors.length > 0
      ? constructors.map(({ target: constructor }) => ({
          ...candidate,
          target: constructor,
        }))
      : [candidate];
  });
  const owners = candidates.filter(({ target: candidate }) =>
    isCloudflareFunctionNode(candidate)
  );
  const activeCandidates = candidates.filter((candidate) =>
    cloudflareActiveExecutionCandidate(
      execution,
      candidate,
      context.lexicalContext
    )
  );
  const activeOwners = activeCandidates.filter(({ target: candidate }) =>
    isCloudflareFunctionNode(candidate)
  );
  activeCandidates.forEach((candidate) =>
    recordCloudflareExecutionCandidate(candidate, context, execution)
  );
  recordCloudflareParameterAccessorReads(execution, activeOwners, context);
  if (owners.length === 0 || activeOwners.length > 0) {
    recordCloudflareExecutionArguments(execution, activeOwners, context);
  }
};

const cloudflareClassConstructor = (classNode) =>
  classNode?.body?.body?.find(
    (element) =>
      nodeType(element) === 'MethodDefinition' &&
      element.kind === 'constructor' &&
      isCloudflareFunctionNode(element.value)
  )?.value;

function cloudflareClassLineage(node, classNode, context, seen) {
  const pending = [{ classNode, depth: 0 }];
  const visited = new Set([...seen].filter(isCloudflareClassNode));
  const lineage = [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (visited.has(current.classNode)) continue;
    assert(
      current.depth <= cloudflareFactoryResolutionLimit,
      cloudflareFactoryResolutionMessage
    );
    visited.add(current.classNode);
    consumeCloudflareAnalysisWork(context, 1);
    lineage.push(current.classNode);
    if (!current.classNode.superClass) continue;
    const nextSeen = new Set(seen).add(current.classNode);
    const superClasses = cloudflareLexicalTargetCandidates(
      node,
      current.classNode.superClass,
      context,
      nextSeen
    )
      .map(({ target }) => target)
      .filter(isCloudflareClassNode);
    consumeCloudflareAnalysisWork(context, superClasses.length);
    superClasses.forEach((superClass) =>
      pending.push({ classNode: superClass, depth: current.depth + 1 })
    );
  }
  return lineage;
}

const cloudflareExecutionConstructors = (execution, target, lexicalContext) =>
  nodeType(execution) === 'NewExpression' && isCloudflareClassNode(target)
    ? cloudflareClassConstructorChainCandidates(
        execution,
        target,
        lexicalContext,
        new Set()
      )
    : [];

const cloudflareMemberAccessKind = (access, lexicalContext) => {
  const parent = lexicalContext.parentNodes.get(access);
  if (nodeType(parent) === 'UpdateExpression') return 'get-set';
  return nodeType(parent) === 'AssignmentExpression' && parent.left === access
    ? 'set'
    : 'get';
};

const recordCloudflareAccessorRead = (access, context) => {
  const lexicalContext = context.lexicalContext;
  if (!lexicalContext.accessorAccessKinds.has(access)) {
    lexicalContext.accessorAccessKinds.set(
      access,
      cloudflareMemberAccessKind(access, lexicalContext)
    );
  }
  cloudflareLexicalTargetCandidates(access, access, lexicalContext).forEach(
    (candidate) =>
      (candidate.accessorOwners ?? []).forEach((accessorOwner) =>
        recordCloudflareExecutionCandidate(
          { ...accessorOwner, accessorOwners: undefined },
          context
        )
      )
  );
};

const recordCloudflareRestGetterAccesses = (source, node, context) => {
  cloudflareLexicalTargetCandidates(node, source, context.lexicalContext)
    .filter(({ target }) => nodeType(target) === 'ObjectExpression')
    .forEach(({ target }) =>
      target.properties
        .filter(({ kind }) => kind === 'get')
        .forEach((property) => {
          const access = cloudflareProjectionMember(
            source,
            propertyKeyName(property)
          );
          recordCloudflareAccessorRead(access, context);
        })
    );
};

const recordCloudflarePatternAccessorReads = (
  pattern,
  source,
  node,
  context
) => {
  if (nodeType(pattern) !== 'ObjectPattern') return;
  pattern.properties.forEach((property) => {
    if (nodeType(property) === 'RestElement') {
      recordCloudflareRestGetterAccesses(source, node, context);
      return;
    }
    const member = propertyKeyName(property);
    assert(
      member !== undefined,
      'Cloudflare load-effect analysis requires static destructuring keys'
    );
    const access = cloudflareProjectionMember(source, member);
    recordCloudflareAccessorRead(access, context);
    recordCloudflarePatternAccessorReads(property.value, access, node, context);
  });
};

const recordCloudflareParameterAccessorReads = (
  execution,
  ownerCandidates,
  context
) =>
  ownerCandidates.forEach(({ target: owner }) =>
    owner.params.forEach((parameter, index) => {
      const source = execution.arguments?.[index];
      if (source) {
        recordCloudflarePatternAccessorReads(
          parameter,
          source,
          execution,
          context
        );
      }
    })
  );

const scanCloudflareExecutions = (owner, context) => {
  cloudflareExecutionTargets(owner, context.lexicalContext).forEach(
    ({ node, target }) => recordCloudflareExecution(node, target, context)
  );
  cloudflareMemberAccesses(owner, context.lexicalContext).forEach((access) =>
    recordCloudflareAccessorRead(access, context)
  );
  cloudflarePatternAccesses(owner, context.lexicalContext).forEach(
    ({ node, pattern, source }) =>
      recordCloudflarePatternAccessorReads(pattern, source, node, context)
  );
};

const cloudflareReturnedMemberTarget = (target, member) => ({
  computed: typeof member === 'number',
  object: target,
  property:
    typeof member === 'number'
      ? { type: 'Literal', value: member }
      : { name: member, type: 'Identifier' },
  type: 'MemberExpression',
});

const cloudflareReturnedInvocationStep = (target, projection) =>
  isCloudflareReturnedCallProjection(projection)
    ? {
        arguments: [],
        callee: target,
        optional: false,
        type: 'CallExpression',
      }
    : cloudflareReturnedMemberTarget(target, projection);

const cloudflareReturnedInvocationTarget = (returned, returnedPath) =>
  returnedPath.reduce(cloudflareReturnedInvocationStep, returned);

const cloudflareFactoryCaptureNames = (factory, returnedFunction) => {
  const parameters = new Set(
    cloudflareParameterEntries(factory).map(({ name }) => name)
  );
  return [...freeIdentifierNames(returnedFunction)].filter((name) =>
    parameters.has(name)
  );
};

const cloudflareCandidateFactoryCaptureNames = (candidate) => {
  const capturedNames = freeIdentifierNames(candidate.target);
  return [...(candidate.factoryBindings?.keys() ?? [])].filter((name) =>
    capturedNames.has(name)
  );
};

const cloudflareCoveredFactoryCaptureNames = (
  factory,
  captureNames,
  callableArgumentIndexes
) => {
  const callableIndexes = new Set(callableArgumentIndexes ?? []);
  const parameterEntries = cloudflareParameterEntries(factory);
  return new Set(
    captureNames.filter((name) =>
      parameterEntries.some(
        (entry) => entry.name === name && callableIndexes.has(entry.index)
      )
    )
  );
};

const cloudflareMissingFactoryParameterIsNonCallable = (
  factory,
  target,
  argumentCount
) => {
  if (nodeType(target) !== 'Identifier') return false;
  const entry = cloudflareParameterEntries(factory).find(
    ({ name }) => name === target.name
  );
  return (
    entry !== undefined &&
    nodeType(entry.parameter) === 'Identifier' &&
    entry.index >= argumentCount
  );
};

const cloudflareFactoryResultIsProvablyNonCallable = (factory, argumentCount) =>
  Number.isInteger(argumentCount) &&
  cloudflareFunctionReturnExpressions(factory).every((returned) =>
    [
      new Set([
        'ArrayExpression',
        'Literal',
        'ObjectExpression',
        'TemplateLiteral',
      ]).has(nodeType(returned)),
      cloudflareMissingFactoryParameterIsNonCallable(
        factory,
        returned,
        argumentCount
      ),
    ].includes(true)
  );

const cloudflareConstructorReturnsNonCallableValues = (constructor) =>
  cloudflareFunctionReturnExpressions(constructor).every((returned) =>
    cloudflareStructuralArgumentCandidateTypes.has(nodeType(returned))
  );

const cloudflareClassConstructionState = (classNode, returnedPath, seen) => {
  const eligible = [returnedPath.length === 0, !seen.has(classNode)].every(
    Boolean
  );
  if (!eligible) return undefined;
  const constructor = cloudflareClassConstructor(classNode);
  const constructorIsSafe = [
    constructor === undefined,
    constructor && cloudflareConstructorReturnsNonCallableValues(constructor),
  ].includes(true);
  if (!constructorIsSafe) return undefined;
  return { constructor, nextSeen: new Set(seen).add(classNode) };
};

const cloudflareNonLocalSuperClassIsNonCallable = (
  classNode,
  constructor,
  lexicalContext
) => {
  const constructorCallsSuper =
    constructor !== undefined &&
    cloudflareExecutionTargets(constructor, lexicalContext).some(
      ({ target }) => nodeType(target) === 'Super'
    );
  const importedSuperClass = directImportedCloudflareInvocation(
    lexicalContext.program,
    classNode.superClass,
    lexicalContext.topLevelBindings
  );
  const importedConstructorIsTracked = [
    Boolean(importedSuperClass),
    constructorCallsSuper,
  ].every(Boolean);
  const isUnshadowedError = [
    identifierName(classNode.superClass) === 'Error',
    !artifactOwnerLexicalBinding(classNode, 'Error', lexicalContext),
  ].every(Boolean);
  return [importedConstructorIsTracked, isUnshadowedError].includes(true);
};

function cloudflareClassConstructionIsProvablyNonCallable(
  classNode,
  returnedPath,
  lexicalContext,
  seen = new Set()
) {
  const state = cloudflareClassConstructionState(classNode, returnedPath, seen);
  if (!state) return false;
  if (!classNode.superClass) return true;
  const superClasses = cloudflareLexicalTargetCandidates(
    classNode.superClass,
    classNode.superClass,
    lexicalContext,
    state.nextSeen
  ).map(({ target }) => target);
  if (superClasses.every((superClass) => !isCloudflareClassNode(superClass))) {
    return cloudflareNonLocalSuperClassIsNonCallable(
      classNode,
      state.constructor,
      lexicalContext
    );
  }
  return cloudflareSuperClassConstructionsAreNonCallable(
    superClasses,
    returnedPath,
    lexicalContext,
    state.nextSeen
  );
}

const cloudflareSuperClassConstructionsAreNonCallable = (
  superClasses,
  returnedPath,
  lexicalContext,
  seen
) =>
  superClasses.length > 0 &&
  superClasses.every(
    (superClass) =>
      isCloudflareClassNode(superClass) &&
      cloudflareClassConstructionIsProvablyNonCallable(
        superClass,
        returnedPath,
        lexicalContext,
        seen
      )
  );

const cloudflareReturnedInvocationFactory = (
  invocation,
  lexicalContext,
  allowUnresolved
) => {
  const factory = resolveCloudflareTarget(
    { name: invocation.localName, type: 'Identifier' },
    lexicalContext.topLevelBindings
  );
  const hasAnalyzableOwner = [
    isCloudflareFunctionNode(factory),
    isCloudflareClassNode(factory),
  ].includes(true);
  assert(
    [hasAnalyzableOwner, allowUnresolved].includes(true),
    `Cloudflare load-effect analysis requires a statically analyzable imported factory owner in ${cloudflareKeyValue(
      lexicalContext.analysisLabel,
      'unknown chunk'
    )} from ${cloudflareKeyValue(
      invocation.callerAnalysisLabel,
      'unknown caller'
    )} (${invocation.localName}:${JSON.stringify(
      invocation.returnedPath
    )} -> ${nodeType(factory)}:${cloudflareKeyValue(
      identifierName(factory),
      ''
    )})`
  );
  if (!hasAnalyzableOwner) return undefined;
  return factory;
};

const cloudflareReturnedFactoryCandidates = (
  factory,
  returnedPath,
  lexicalContext
) => {
  if (!isCloudflareFunctionNode(factory)) return [];
  return cloudflareFunctionReturnExpressions(factory).flatMap((returned) => {
    const target = cloudflareReturnedInvocationTarget(returned, returnedPath);
    return cloudflareLexicalTargetCandidates(
      target,
      target,
      lexicalContext
    ).filter(({ target: candidate }) => isCloudflareFunctionNode(candidate));
  });
};

const cloudflareFactoryReturnsCallableArgument = (
  factory,
  invocation,
  lexicalContext
) => {
  if (!isCloudflareFunctionNode(factory)) return false;
  const callableIndexes = new Set(
    invocation.factoryCallableArgumentIndexes ?? []
  );
  const callableParameters = new Set(
    cloudflareParameterEntries(factory)
      .filter(({ index }) => callableIndexes.has(index))
      .map(({ name }) => name)
  );
  const returns = cloudflareFunctionReturnExpressions(factory);
  return (
    callableParameters.size > 0 &&
    returns.length > 0 &&
    returns.every((returned) => {
      const assigned = cloudflareUnshadowedObjectAssignArguments(
        returned,
        lexicalContext
      );
      return (
        assigned?.length > 0 &&
        nodeType(assigned[0]) === 'Identifier' &&
        callableParameters.has(assigned[0].name)
      );
    })
  );
};

const cloudflareReturnedFactoryCanRemainUnresolved = (
  factory,
  invocation,
  lexicalContext,
  allowUnresolved
) => {
  const functionResultIsNonCallable = isCloudflareFunctionNode(factory)
    ? cloudflareFactoryResultIsProvablyNonCallable(
        factory,
        invocation.factoryArgumentCount
      )
    : false;
  const classResultIsNonCallable = isCloudflareClassNode(factory)
    ? cloudflareClassConstructionIsProvablyNonCallable(
        factory,
        invocation.returnedPath,
        lexicalContext
      )
    : false;
  return [
    allowUnresolved,
    invocation.reviewedFactoryOrigin === true,
    invocation.factoryCaptureResolutionProven === true,
    cloudflareFactoryReturnsCallableArgument(
      factory,
      invocation,
      lexicalContext
    ),
    functionResultIsNonCallable,
    classResultIsNonCallable,
  ].includes(true);
};

const cloudflareAssertReturnedFactoryCandidates = (
  factory,
  invocation,
  candidates,
  lexicalContext,
  allowUnresolved
) => {
  assert(
    [
      candidates.length > 0,
      cloudflareReturnedFactoryCanRemainUnresolved(
        factory,
        invocation,
        lexicalContext,
        allowUnresolved
      ),
    ].includes(true),
    `Cloudflare load-effect analysis requires a statically analyzable imported factory result in ${cloudflareKeyValue(
      lexicalContext.analysisLabel,
      'unknown chunk'
    )} from ${cloudflareKeyValue(
      invocation.callerAnalysisLabel,
      'unknown caller'
    )} (${invocation.localName}:${JSON.stringify(
      invocation.returnedPath
    )}; args=${String(
      invocation.factoryArgumentCount
    )}; returns=${cloudflareFunctionReturnExpressions(factory)
      .map((returned) => nodeType(returned))
      .join(',')})`
  );
};

const cloudflareAssertFactoryCapture = (
  factory,
  invocation,
  candidate,
  lexicalContext
) => {
  const captureNames = [
    ...cloudflareFactoryCaptureNames(factory, candidate.target),
    ...cloudflareCandidateFactoryCaptureNames(candidate),
  ];
  const coveredCaptureNames = cloudflareCoveredFactoryCaptureNames(
    factory,
    captureNames,
    [
      ...cloudflareKeyValue(invocation.factoryCallableArgumentIndexes, []),
      ...cloudflareKeyValue(invocation.factoryResolvedArgumentIndexes, []),
    ]
  );
  const uncoveredCaptureNames = captureNames.filter(
    (name) => !coveredCaptureNames.has(name)
  );
  assert(
    uncoveredCaptureNames.length === 0,
    `Cloudflare load-effect analysis requires statically analyzable cross-chunk factory captures in ${cloudflareKeyValue(
      lexicalContext.analysisLabel,
      'unknown chunk'
    )} (${invocation.localName}:${JSON.stringify(
      invocation.returnedPath
    )} -> ${uncoveredCaptureNames.join(',')})`
  );
};

const cloudflareReturnedInvocationFunctions = (
  _program,
  invocations,
  lexicalContext,
  allowUnresolved = false
) =>
  invocations.flatMap((invocation) => {
    const factory = cloudflareReturnedInvocationFactory(
      invocation,
      lexicalContext,
      allowUnresolved
    );
    if (!factory) return [];
    const candidates = cloudflareReturnedFactoryCandidates(
      factory,
      invocation.returnedPath,
      lexicalContext
    );
    cloudflareAssertReturnedFactoryCandidates(
      factory,
      invocation,
      candidates,
      lexicalContext,
      allowUnresolved
    );
    candidates.forEach((candidate) =>
      cloudflareAssertFactoryCapture(
        factory,
        invocation,
        candidate,
        lexicalContext
      )
    );
    return candidates.map(({ target }) => target);
  });

const cloudflareInitialInvocationOwners = (target, lexicalContext) => {
  if (isCloudflareFunctionNode(target)) return [target];
  if (!isCloudflareClassNode(target)) return [];
  return [
    target,
    ...cloudflareClassConstructorChainCandidates(
      target,
      target,
      lexicalContext,
      new Set()
    ).map(({ target: constructor }) => constructor),
  ];
};

const dormantCloudflareFunctionRanges = (
  program,
  initiallyInvoked = [],
  initiallyInvokedReturns = [],
  analysisLabel,
  initiallyInvokedFunctionKeys = [],
  artifactRoot
) => {
  const bindings = cloudflareTopLevelBindings(program);
  const lexicalContext = createCloudflareLexicalContext(program, analysisLabel);
  if (artifactRoot) {
    lexicalContext.artifactRoot = fs.realpathSync(artifactRoot);
    lexicalContext.chunkFile = fs.realpathSync(
      path.resolve(artifactRoot, analysisLabel)
    );
  }
  const functionsByKey = new Map(
    cloudflareFunctionNodes(program).map((functionNode) => [
      cloudflareNodeSemanticKey(functionNode),
      functionNode,
    ])
  );
  const invokedByKey = initiallyInvokedFunctionKeys.map((key) =>
    functionsByKey.get(key)
  );
  assert(
    invokedByKey.every(Boolean),
    `Cloudflare load-effect analysis requires stable local callback ownership in ${analysisLabel ?? 'unknown chunk'}`
  );
  const invoked = new Set([
    ...initiallyInvoked
      .flatMap((name) => {
        const identifier = { type: 'Identifier', name };
        return cloudflareLexicalTargetCandidates(
          identifier,
          identifier,
          lexicalContext
        ).flatMap(({ target }) =>
          cloudflareInitialInvocationOwners(target, lexicalContext)
        );
      })
      .filter(Boolean),
    ...cloudflareReturnedInvocationFunctions(
      program,
      initiallyInvokedReturns,
      lexicalContext
    ),
    ...invokedByKey,
  ]);
  const importedInvocations = new Map();
  const pending = [...invoked];
  const processedRevision = new WeakMap();
  const addInvoked = (owner, force = false) => {
    if (!owner) return;
    const isNew = !invoked.has(owner);
    if (isNew) invoked.add(owner);
    if ([isNew, force].includes(true)) pending.push(owner);
  };
  const context = {
    addInvoked,
    bindings,
    importedInvocations,
    lexicalContext,
    program,
  };
  scanCloudflareExecutions(program, context);
  while (pending.length > 0) {
    const owner = pending.pop();
    const revision =
      lexicalContext.factoryBindingRevisionByFunction.get(owner) ?? 0;
    if (processedRevision.get(owner) === revision) continue;
    processedRevision.set(owner, revision);
    scanCloudflareExecutions(owner, context);
  }
  return {
    importedInvocations,
    invokedFunctions: invoked,
    lexicalContext,
    ranges: cloudflareFunctionNodes(program)
      .filter((functionNode) => !invoked.has(functionNode))
      .map((functionNode) => [functionNode.start, functionNode.end]),
  };
};

const cloudflareGlobalOwners = new Set(['globalThis', 'self', 'window']);

const cloudflareUnshadowedGlobalOwnerName = (target, bindings) => {
  const name = identifierName(target);
  return cloudflareGlobalOwners.has(name) && !bindings.has(name)
    ? name
    : undefined;
};

const cloudflareGlobalIdentityReflectiveRead = (
  target,
  bindings,
  seen,
  depth
) => {
  if (nodeType(target) !== 'CallExpression') return false;
  const callee = resolveCloudflareTarget(target.callee, bindings);
  if (nodeType(callee) !== 'MemberExpression') return false;
  const owner = identifierName(callee.object);
  const operation = cloudflareMemberName(callee);
  if (!new Set(['Object', 'Reflect']).has(owner) || bindings.has(owner)) {
    return false;
  }
  const expectedOperation =
    owner === 'Reflect' ? 'get' : 'getOwnPropertyDescriptor';
  return (
    operation === expectedOperation &&
    cloudflareGlobalOwners.has(
      cloudflareLiteralMemberName(target.arguments[1])
    ) &&
    isCloudflareGlobalIdentityTarget(
      target.arguments[0],
      bindings,
      seen,
      depth + 1
    )
  );
};

const isCloudflareGlobalIdentityTarget = (
  node,
  bindings,
  seen = new Set(),
  depth = 0
) => {
  assert(
    depth <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  const target = resolveCloudflareTarget(node, bindings);
  if (!target || seen.has(target)) return false;
  if (cloudflareUnshadowedGlobalOwnerName(target, bindings)) return true;
  const nextSeen = new Set(seen).add(target);
  if (
    cloudflareGlobalIdentityReflectiveRead(target, bindings, nextSeen, depth)
  ) {
    return true;
  }
  if (nodeType(target) !== 'MemberExpression') return false;
  const member = cloudflareMemberName(target);
  if (cloudflareGlobalOwners.has(member)) {
    return isCloudflareGlobalIdentityTarget(
      target.object,
      bindings,
      nextSeen,
      depth + 1
    );
  }
  return (
    member === 'value' &&
    cloudflareGlobalIdentityReflectiveRead(
      target.object,
      bindings,
      nextSeen,
      depth + 1
    )
  );
};

const isGlobalMemberCall = (node, member, bindings) => {
  const target = resolveCloudflareTarget(node, bindings);
  return (
    nodeType(target) === 'MemberExpression' &&
    isCloudflareGlobalIdentityTarget(target.object, bindings) &&
    (cloudflareMemberName(target) === member ||
      target.cloudflareWildcardMember === true)
  );
};

const cloudflareKnownFunctionMembers = new Set(['toString', 'valueOf']);

const isCloudflareKnownFunctionMemberTarget = (target) =>
  nodeType(target) === 'MemberExpression' &&
  cloudflareKnownFunctionMembers.has(cloudflareMemberName(target));

const isCloudflareIndirectFunctionConstructor = (target) => {
  if (
    nodeType(target) !== 'MemberExpression' ||
    cloudflareMemberName(target) !== 'constructor'
  ) {
    return false;
  }
  const owner = unwrapCloudflareExecutionTarget(target.object);
  return (
    isCloudflareFunctionNode(owner) ||
    isCloudflareKnownFunctionMemberTarget(owner)
  );
};

const isCloudflareReflectConstruct = (target, bindings) =>
  isCloudflareNamedMemberExecution(target, 'Reflect', 'construct', bindings);

const hasCloudflareUnsafeReflectConstructor = (candidates) =>
  candidates.length === 0 ||
  candidates.some(({ target }) =>
    new Set(['Function', 'Proxy']).has(identifierName(target))
  );

const isCloudflareUnsafeReflectConstructAt = (node, lexicalContext) => {
  if (
    !isCloudflareReflectConstruct(node.callee, lexicalContext.topLevelBindings)
  ) {
    return false;
  }
  const constructor = node.arguments?.[0];
  if (!constructor) return true;
  const candidates = cloudflareLexicalTargetCandidates(
    node,
    constructor,
    lexicalContext
  );
  return hasCloudflareUnsafeReflectConstructor(candidates);
};

const isCloudflareLoadEffectTarget = (target, effects, bindings) => {
  const resolved = cloudflareCallableTarget(target, bindings);
  return (
    isCloudflareObjectPropertyDefinition(resolved, bindings) ||
    isCloudflareIndirectFunctionConstructor(resolved) ||
    effects.has(identifierName(resolved)) ||
    [...effects].some((member) =>
      isGlobalMemberCall(resolved, member, bindings)
    )
  );
};

const isCloudflareLoadEffectCandidateAt = (
  node,
  candidate,
  effects,
  lexicalContext
) => {
  assert(
    candidate.target?.cloudflareOpaqueSpreadElement !== true &&
      candidate.target?.cloudflareOpaqueIteratorElement !== true &&
      !(candidate.parameterPath ?? []).some(
        isCloudflareOpaqueArraySpreadProjection
      ),
    `${cloudflareOpaqueAggregateSpreadMessage} reaches a callable position in ${lexicalContext.analysisLabel}`
  );
  if (candidate.parameterName !== undefined) return false;
  if (isCloudflareUnsafeReflectConstructAt(node, lexicalContext)) return true;
  if (isCloudflareDirectProxyConstruction(node, lexicalContext)) {
    return false;
  }
  const propertyDefinition = isCloudflareObjectPropertyDefinition(
    candidate.target,
    lexicalContext.topLevelBindings
  );
  if (propertyDefinition)
    return isCloudflareUnsafePropertyDefinitionAt(
      node,
      candidate.target,
      lexicalContext
    );
  return isCloudflareLoadEffectTarget(
    candidate.target,
    effects,
    lexicalContext.topLevelBindings
  );
};

const isCloudflareLoadEffectTargetAt = (
  node,
  target,
  effects,
  lexicalContext
) =>
  cloudflareLexicalTargetCandidates(node, target, lexicalContext).some(
    (candidate) =>
      isCloudflareLoadEffectCandidateAt(
        node,
        candidate,
        effects,
        lexicalContext
      )
  );

const isCloudflareDirectProxyConstruction = (
  node,
  context,
  bindings = context.topLevelBindings
) => {
  if (
    nodeType(node) !== 'NewExpression' ||
    identifierName(node.callee) !== 'Proxy'
  ) {
    return false;
  }
  if (context.lexicalBindingsByNode) {
    return !artifactOwnerLexicalBinding(node, 'Proxy', context);
  }
  return !bindings?.has('Proxy');
};

const cloudflareImportedOwnerState = (
  chunkFile,
  source,
  artifactRoot,
  message,
  visited
) => {
  assert(source?.startsWith('./'), message);
  const ownerFile = path.resolve(path.dirname(chunkFile), source);
  assert(isWithinDirectory(ownerFile, artifactRoot), message);
  assertFile(ownerFile);
  assert(
    isWithinDirectory(
      fs.realpathSync(ownerFile),
      fs.realpathSync(artifactRoot)
    ),
    message
  );
  return {
    ownerFile,
    ownerState: cloudflareLoadEffectStateFor(ownerFile, undefined, visited),
  };
};

const cloudflareImportedInvocationOwnerRecord = (
  program,
  chunkFile,
  invocation,
  artifactRoot,
  message,
  visited
) => {
  const matches = staticImportsForBinding(program, invocation.localName);
  assert(matches.length === 1, message);
  const [{ source }] = matches;
  assert(source === invocation.source, message);
  const { ownerFile, ownerState } = cloudflareImportedOwnerState(
    chunkFile,
    source,
    artifactRoot,
    message,
    visited
  );
  const ownerProgram = ownerState.program;
  const exports = new Map(ownerProgram.body.flatMap(moduleExportEntries));
  const localName = exports.get(invocation.importedName);
  assert(typeof localName === 'string', message);
  return {
    invocation: { ...invocation, localName },
    ownerFile,
  };
};

const cloudflareResolvedFactoryOriginLineage = (
  program,
  target,
  lexicalContext,
  seen,
  depth
) => {
  const imported = importedCloudflareFactoryResultInvocation(
    program,
    target,
    lexicalContext.topLevelBindings
  );
  if (imported) return { complete: true, origins: [imported] };
  const resolved = resolveCloudflareTarget(
    target,
    lexicalContext.topLevelBindings
  );
  if (resolved && resolved !== target) {
    return cloudflareFactoryOriginLineage(
      program,
      resolved,
      lexicalContext,
      seen,
      depth + 1
    );
  }
  return undefined;
};

const cloudflareFactoryLineageCandidates = (target, lexicalContext, seen) => {
  if (nodeType(target) !== 'CallExpression') return [];
  return cloudflareLexicalTargetCandidates(
    target,
    target.callee,
    lexicalContext,
    seen
  ).filter(({ target: candidate }) => isCloudflareFunctionNode(candidate));
};

const cloudflareFactoryLineagesResult = (lineages) => ({
  complete:
    lineages.length > 0 && lineages.every((lineage) => lineage.complete),
  origins: lineages.flatMap(({ origins }) => origins),
});

const cloudflareFactoryOriginLineage = (
  program,
  target,
  lexicalContext,
  seen = new Set(),
  depth = 0
) => {
  assert(
    depth <= cloudflareFactoryResolutionLimit,
    cloudflareFactoryResolutionMessage
  );
  const targetKey = target ? cloudflareNodeSemanticKey(target) : undefined;
  const eligible = [Boolean(target), !seen.has(targetKey)].every(Boolean);
  if (!eligible) return { complete: false, origins: [] };
  const nextSeen = new Set(seen).add(targetKey);
  const resolved = cloudflareResolvedFactoryOriginLineage(
    program,
    target,
    lexicalContext,
    nextSeen,
    depth
  );
  if (resolved) return resolved;
  const factories = cloudflareFactoryLineageCandidates(
    target,
    lexicalContext,
    nextSeen
  );
  if (factories.length === 0) return { complete: false, origins: [] };
  const lineages = factories.flatMap(({ target: factory }) =>
    cloudflareFunctionReturnExpressions(factory).map((returned) =>
      cloudflareFactoryOriginLineage(
        program,
        returned,
        lexicalContext,
        nextSeen,
        depth + 1
      )
    )
  );
  return cloudflareFactoryLineagesResult(lineages);
};

const cloudflareReviewedOwnerFile = (
  program,
  chunkFile,
  invocation,
  artifactRoot
) => {
  const imports = staticImportsForBinding(program, invocation.localName);
  if (imports.length !== 1) return undefined;
  const [{ source }] = imports;
  const sourceMatches = [
    source === invocation.source,
    source.startsWith('./'),
  ].every(Boolean);
  if (!sourceMatches) return undefined;
  const ownerFile = path.resolve(path.dirname(chunkFile), source);
  const fileIsEligible = [
    isWithinDirectory(ownerFile, artifactRoot),
    fs.existsSync(ownerFile),
  ].every(Boolean);
  if (!fileIsEligible) return undefined;
  return ownerFile;
};

const cloudflareInvocationHasReviewedOwner = (
  program,
  chunkFile,
  invocation,
  artifactRoot
) => {
  const ownerFile = cloudflareReviewedOwnerFile(
    program,
    chunkFile,
    invocation,
    artifactRoot
  );
  if (!ownerFile) return false;
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    ownerFile,
    'reviewed factory origin'
  );
  return isReviewedCloudflareNonAppClosure(
    cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord)
  );
};

const cloudflareFactoryReturnedOwnersAreUnmutated = (program, factory) => {
  const returnedRoots = new Set(
    cloudflareFunctionReturnExpressions(factory).flatMap((returned) => [
      ...freeIdentifierNames(returned),
    ])
  );
  return cloudflareReturnedOwnersAreUnmutated(program, returnedRoots);
};

const cloudflareFactoryHasReviewedOrigin = (
  program,
  chunkFile,
  localName,
  artifactRoot
) => {
  const lexicalContext = createCloudflareLexicalContext(
    program,
    normalizeArtifactFile(artifactRoot, chunkFile)
  );
  const factory = resolveCloudflareTarget(
    { name: localName, type: 'Identifier' },
    lexicalContext.topLevelBindings
  );
  if (!isCloudflareFunctionNode(factory)) return false;
  if (!cloudflareFactoryReturnedOwnersAreUnmutated(program, factory)) {
    return false;
  }
  const lineages = cloudflareFunctionReturnExpressions(factory).map(
    (returned) =>
      cloudflareFactoryOriginLineage(program, returned, lexicalContext)
  );
  return (
    lineages.length > 0 &&
    lineages.every(
      (lineage) =>
        lineage.complete &&
        lineage.origins.length > 0 &&
        lineage.origins.every((origin) =>
          cloudflareInvocationHasReviewedOwner(
            program,
            chunkFile,
            origin,
            artifactRoot
          )
        )
    )
  );
};

const cloudflareImportedOwner = (
  program,
  chunkFile,
  invocations,
  artifactRoot,
  message,
  visited
) => {
  const imports = invocations.map((invocation) => {
    const matches = staticImportsForBinding(program, invocation.localName);
    assert(matches.length === 1, message);
    return { invocation, imported: matches[0] };
  });
  const sources = new Set(imports.map(({ imported }) => imported.source));
  assert(sources.size === 1, message);
  const [source] = sources;
  const { ownerFile, ownerState } = cloudflareImportedOwnerState(
    chunkFile,
    source,
    artifactRoot,
    message,
    visited
  );
  const ownerManifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    ownerFile,
    'imported load-effect owner'
  );
  const reviewedClosure = reviewedCloudflareNonAppClosure(
    cloudflareManifestChunkRecord(ownerManifestRecord.key, ownerManifestRecord)
  );
  const reviewedNonAppClosure = reviewedClosure !== undefined;
  const ownerProgram = ownerState.program;
  const exports = new Map(ownerProgram.body.flatMap(moduleExportEntries));
  const localNames = imports.map(({ invocation }) => {
    const localName = exports.get(invocation.importedName);
    assert(typeof localName === 'string', message);
    return localName;
  });
  const reviewedFactoryOrigins = new Map(
    [...new Set(localNames)].map((localName) => [
      localName,
      cloudflareFactoryHasReviewedOrigin(
        ownerProgram,
        ownerFile,
        localName,
        artifactRoot
      ),
    ])
  );
  const factoryArgumentOrigins = imports.map(({ invocation }) =>
    (invocation.factoryArgumentOrigins ?? []).map((origin) => ({
      ...origin,
      ...cloudflareImportedInvocationOwnerRecord(
        program,
        chunkFile,
        origin.invocation,
        artifactRoot,
        message,
        visited
      ),
    }))
  );
  const returnedInvocations = imports.flatMap(({ invocation }, index) =>
    invocation.returnedPath
      ? [
          {
            callerAnalysisLabel: invocation.callerAnalysisLabel,
            deferredArgumentHazardIndexes:
              invocation.deferredArgumentHazardIndexes,
            factoryArgumentCount: invocation.factoryArgumentCount,
            factoryCaptureResolutionProven:
              invocation.factoryCaptureResolutionProven,
            factoryCallableArgumentIndexes:
              invocation.factoryCallableArgumentIndexes,
            factoryResolvedArgumentIndexes:
              invocation.factoryResolvedArgumentIndexes,
            localName: localNames[index],
            reviewedFactoryOrigin:
              reviewedFactoryOrigins.get(localNames[index]) === true,
            returnedPath: invocation.returnedPath,
          },
        ]
      : []
  );
  const opaqueArgumentInvocations = imports.flatMap(({ invocation }, index) =>
    (invocation.opaqueArgumentIndexes?.length ?? 0) > 0
      ? [
          {
            callerAnalysisLabel: invocation.callerAnalysisLabel,
            factoryArgumentCount: invocation.factoryArgumentCount,
            factoryArgumentOrigins: factoryArgumentOrigins[index],
            factoryCaptureResolutionProven:
              invocation.factoryCaptureResolutionProven,
            factoryCallableArgumentIndexes:
              invocation.factoryCallableArgumentIndexes,
            factoryResolvedArgumentIndexes:
              invocation.factoryResolvedArgumentIndexes,
            localCallableArgumentOrigins: (
              invocation.localCallableArgumentOrigins ?? []
            ).map((origin) => ({
              ...origin,
              ownerFile: chunkFile,
            })),
            localName: localNames[index],
            opaqueArgumentIndexes: invocation.opaqueArgumentIndexes,
            opaqueArgumentOrigins: (invocation.opaqueArgumentOrigins ?? []).map(
              (origin) => {
                return {
                  ...origin,
                  ...cloudflareImportedInvocationOwnerRecord(
                    program,
                    chunkFile,
                    origin.invocation,
                    artifactRoot,
                    message,
                    visited
                  ),
                };
              }
            ),
            returnedPath: invocation.returnedPath,
            reviewedDeferredArguments: isSafeReviewedDeferredInvocation(
              program,
              invocation,
              localNames[index],
              reviewedClosure,
              artifactRoot,
              factoryArgumentOrigins[index]
            ),
            reviewedFactoryOrigin:
              reviewedFactoryOrigins.get(localNames[index]) === true,
          },
        ]
      : []
  );
  return {
    localNames: [...new Set(localNames)],
    opaqueArgumentInvocations,
    ownerFile,
    ownerProgram,
    reviewedClosure,
    reviewedNonAppClosure,
    returnedInvocations,
  };
};

const cloudflareDestructuredFactoryPropertyName = (pattern, localName) => {
  if (nodeType(pattern) !== 'ObjectPattern') return undefined;
  const property = pattern.properties.find(
    (candidate) =>
      nodeType(candidate) === 'Property' &&
      bindingNames(candidate.value).includes(localName)
  );
  return property ? propertyKeyName(property) : undefined;
};

const cloudflareDirectReturnedCallableValues = (
  factory,
  propertyName,
  lexicalContext
) => {
  const returned = cloudflareFunctionReturnExpressions(factory);
  const groups = returned.map((expression) => {
    const target = unwrapCloudflareExecutionTarget(expression);
    if (nodeType(target) !== 'ObjectExpression') return [];
    const property = target.properties.findLast(
      (candidate) =>
        nodeType(candidate) === 'Property' &&
        candidate.kind === 'init' &&
        propertyKeyName(candidate) === propertyName
    );
    const value = property?.value;
    if (isCloudflareFunctionNode(value)) return [value];
    return nodeType(value) === 'Identifier'
      ? cloudflareDirectLocalBindingValues(value, value, lexicalContext).filter(
          isCloudflareFunctionNode
        )
      : [];
  });
  return returned.length > 0 && groups.every((group) => group.length > 0)
    ? groups.flat()
    : [];
};

const cloudflareDestructuredFactoryCallableOwners = (
  ownerProgram,
  localName,
  lexicalContext
) => {
  const declarators = cloudflareTopLevelVariableDeclarators(
    ownerProgram
  ).filter((declarator) => bindingNames(declarator.id).includes(localName));
  if (declarators.length !== 1) return [];
  const [declarator] = declarators;
  const propertyName = cloudflareDestructuredFactoryPropertyName(
    declarator.id,
    localName
  );
  const init = unwrapCloudflareExecutionTarget(declarator.init);
  if (propertyName === undefined || nodeType(init) !== 'CallExpression') {
    return [];
  }
  const factory = resolveCloudflareTarget(
    init.callee,
    lexicalContext.topLevelBindings
  );
  return isCloudflareFunctionNode(factory)
    ? cloudflareDirectReturnedCallableValues(
        factory,
        propertyName,
        lexicalContext
      )
    : [];
};

const cloudflareOpaqueImportedArgumentReturnedInvocations = (
  ownerProgram,
  invocations,
  analysisLabel,
  reviewedClosure
) => {
  if (invocations.length === 0) return [];
  const lexicalContext = createCloudflareLexicalContext(
    ownerProgram,
    analysisLabel
  );
  return invocations.flatMap(
    ({
      callerAnalysisLabel,
      factoryArgumentCount,
      factoryCaptureResolutionProven,
      factoryCallableArgumentIndexes,
      factoryResolvedArgumentIndexes,
      localCallableArgumentOrigins = [],
      localName,
      opaqueArgumentIndexes,
      opaqueArgumentOrigins = [],
      reviewedDeferredArguments,
      reviewedFactoryOrigin,
      returnedPath,
    }) => {
      if (reviewedDeferredArguments === true) return [];
      const opaqueIndexes = new Set(opaqueArgumentIndexes);
      const origins = new Map();
      opaqueArgumentOrigins.forEach((origin) => {
        const values = origins.get(origin.index) ?? [];
        values.push(origin);
        origins.set(origin.index, values);
      });
      localCallableArgumentOrigins.forEach((origin) => {
        const values = origins.get(origin.index) ?? [];
        values.push(origin);
        origins.set(origin.index, values);
      });
      const directFactoryOwners =
        returnedPath === undefined
          ? cloudflareDestructuredFactoryCallableOwners(
              ownerProgram,
              localName,
              lexicalContext
            )
          : [];
      const owners =
        returnedPath === undefined
          ? directFactoryOwners.length > 0
            ? directFactoryOwners
            : cloudflareLexicalTargetCandidates(
                { name: localName, type: 'Identifier' },
                { name: localName, type: 'Identifier' },
                lexicalContext
              )
                .map(({ target }) => target)
                .filter(isCloudflareFunctionNode)
          : cloudflareReturnedInvocationFunctions(
              ownerProgram,
              [
                {
                  callerAnalysisLabel,
                  factoryArgumentCount,
                  factoryCaptureResolutionProven,
                  factoryCallableArgumentIndexes,
                  factoryResolvedArgumentIndexes,
                  localName,
                  reviewedFactoryOrigin,
                  returnedPath,
                },
              ],
              lexicalContext,
              reviewedClosure !== undefined
            );
      assert(
        owners.every(isCloudflareFunctionNode),
        `Cloudflare load-effect analysis requires a statically analyzable imported argument owner in ${analysisLabel} from ${
          callerAnalysisLabel ?? 'unknown caller'
        } (${localName}:${JSON.stringify(returnedPath)} -> ${owners
          .map((owner) => `${nodeType(owner)}:${identifierName(owner) ?? ''}`)
          .join(',')})`
      );
      const projections =
        owners.length === 0
          ? [...opaqueIndexes].map((index) => ({
              entry: { index },
              projection: { path: [], name: '<unresolved-owner>' },
            }))
          : owners.flatMap((owner) => {
              const parameterEntries = cloudflareParameterEntries(owner);
              return cloudflareInvokedParameterProjections(
                owner,
                ownerProgram,
                lexicalContext
              ).flatMap((projection) =>
                parameterEntries
                  .filter(
                    (entry) =>
                      entry.name === projection.name &&
                      opaqueIndexes.has(entry.index)
                  )
                  .map((entry) => ({ entry, projection }))
              );
            });
      return projections.flatMap(({ entry, projection }) => {
        const argumentOrigins = origins.get(entry.index) ?? [];
        const reviewedOpaqueData =
          argumentOrigins.length === 0 &&
          cloudflareReviewedOpaqueDataArgumentIsSafe(
            reviewedClosure,
            localName,
            returnedPath,
            entry.index,
            opaqueIndexes,
            origins
          );
        assert(
          argumentOrigins.length > 0 || reviewedOpaqueData,
          `Cloudflare load-effect analysis rejects invoked opaque imported arguments in ${analysisLabel} from ${
            callerAnalysisLabel ?? 'unknown caller'
          } (${localName}:${JSON.stringify(returnedPath)} -> ${projection.name}:${JSON.stringify(
            projection.path
          )}; origins=${JSON.stringify(
            [...origins].map(([index, values]) => [
              index,
              values.map(
                ({ callableParameterSafetyProven }) =>
                  callableParameterSafetyProven === true
              ),
            ])
          )}; reviewed=${String(reviewedClosure !== undefined)})`
        );
        return argumentOrigins.map((origin) =>
          origin.localFunctionKeys
            ? {
                localFunctionKeys: origin.localFunctionKeys,
                ownerFile: origin.ownerFile,
              }
            : {
                invocation: {
                  ...origin.invocation,
                  returnedPath: [
                    ...(origin.invocation.returnedPath ?? []),
                    ...projection.path,
                  ],
                },
                ownerFile: origin.ownerFile,
              }
        );
      });
    }
  );
};

const groupCloudflareImportedInvocations = (program, invocations, message) => {
  const groups = new Map();
  for (const invocation of invocations) {
    const imports = staticImportsForBinding(program, invocation.localName);
    assert(imports.length === 1, message);
    const [{ source }] = imports;
    const group = groups.get(source) ?? [];
    group.push(invocation);
    groups.set(source, group);
  }
  return groups;
};

const cloudflareLoadEffectModule = (chunkFile, parsedProgram) =>
  parsedProgram
    ? { program: parsedProgram, source: fs.readFileSync(chunkFile, 'utf8') }
    : readParsedModule(chunkFile);

const reviewedTanStackRouterDeferredInvocations = Object.freeze([
  Object.freeze({ localName: 'createFileRoute', returnedPath: [] }),
  Object.freeze({ localName: 'lazyRouteComponent', returnedPath: undefined }),
]);
const reviewedTanStackRouterModulePrefixes = Object.freeze([
  'node_modules/.pnpm/@tanstack+react-router@1.170.16_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/@tanstack/react-router/',
  'node_modules/.pnpm/@tanstack+router-core@1.171.13/node_modules/@tanstack/router-core/',
]);
const reviewedTanStackRouterClosureHashes = Object.freeze([
  '1ec9a7d22ca3ea855e61244180a4032d0ecc1a12b6e4a170a3f963882db1a579',
  '3da90f02928e4f9963b5284c8d37cba934b6c2be7559153078b8571fafc3318b',
  'fbb7b9927a2726680a1cd6a39abfad82bf5cab8f727c4d881e5c2f4435f76dcc',
  '5c19c0772eaa31c437c6d4ef8ce010ce13d47787f61f954394ffc21a4b3eafe0',
]);

const reviewedCloudflareNonAppClosures = Object.freeze([
  Object.freeze({
    modulePrefixes: [
      'node_modules/.pnpm/remeda@2.39.0/node_modules/remeda/dist/',
    ],
    opaqueDataArgumentInvocations: [
      {
        dataIndex: 0,
        localName: 't',
        returnedPath: undefined,
        transformerStartIndex: 1,
      },
    ],
    sha256: 'ce61b357e700cf6d0cbeb6fa6347b15ca30d894b5d3b003790e44be95cd9c174',
  }),
  Object.freeze({
    deferredArgumentInvocations: [
      { localName: 'preprocess', returnedPath: undefined },
      { localName: 'preprocess', returnedPath: ['transform'] },
      { localName: 'string', returnedPathSuffix: ['refine'] },
    ],
    modulePrefixes: ['node_modules/.pnpm/zod@4.4.3/node_modules/zod/'],
    sha256: 'b58b76143de945661f801945b38db191e2fbe55ecd29e98f6d30fd9d54cec758',
  }),
  Object.freeze({
    deferredArgumentInvocations: [
      { localName: 'createServerFn', returnedPathSuffix: ['handler'] },
      { localName: 'createServerFn', returnedPath: ['validator'] },
    ],
    modulePrefixes: [
      'node_modules/.pnpm/@tanstack+router-core@1.171.13/node_modules/@tanstack/router-core/',
      'node_modules/.pnpm/@tanstack+start-client-core@1.170.12/node_modules/@tanstack/start-client-core/',
      'node_modules/.pnpm/cookie-es@3.1.1/node_modules/cookie-es/',
    ],
    sha256: '623a7a02699b2257cd8147816ae14ae5267a5580c0d340d6d2b166a457d57883',
  }),
  Object.freeze({
    delegatedFactoryArguments: [{ index: 0, localName: '__toESM' }],
    modulePrefixes: [
      'non-app:66364e236ec24f3d62d60f62f82cca5694450afb05a0f51ab2a16d0d73781ed3',
    ],
    sha256: 'ee6f7f26af65d579908c6904c08fa7fd954f22673d48974bf74dd8036a83cc71',
  }),
  ...reviewedTanStackRouterClosureHashes.map((sha256) =>
    Object.freeze({
      deferredArgumentInvocations: reviewedTanStackRouterDeferredInvocations,
      modulePrefixes: reviewedTanStackRouterModulePrefixes,
      sha256,
    })
  ),
  Object.freeze({
    deferredArgumentInvocations: [
      { localName: 'require_jsx_runtime', returnedPath: ['jsx'] },
      { localName: 'require_jsx_runtime', returnedPath: ['jsxs'] },
    ],
    modulePrefixes: ['node_modules/.pnpm/react@19.2.7/node_modules/react/'],
    sha256: 'afa718acebb3c7ab2165b64c9c111e4b62c0e89065df9e12a64e59f994c920bb',
  }),
  Object.freeze({
    deferredMemberInvocations: ['createContext', 'forwardRef', 'lazy', 'memo'],
    modulePrefixes: ['node_modules/.pnpm/react@19.2.7/node_modules/react/'],
    sha256: '8b823a5b4929d5cb9a1cf9e52db920df93e4b472192815dba366c7b9ab086296',
  }),
]);

const reviewedCloudflareNonAppClosure = (record) =>
  record.ownership === 'non-app'
    ? reviewedCloudflareNonAppClosures.find(
        ({ modulePrefixes, sha256 }) =>
          record.sha256 === sha256 &&
          record.modules.length > 0 &&
          record.modules.every(
            (module) =>
              module.owner === 'non-app' &&
              modulePrefixes.some((prefix) => module.id.startsWith(prefix))
          )
      )
    : undefined;

const isReviewedCloudflareNonAppClosure = (record) =>
  reviewedCloudflareNonAppClosure(record) !== undefined;

const cloudflareReturnedPathEndsWith = (returnedPath, suffix) =>
  returnedPath.length >= suffix.length &&
  suffix.every(
    (part, index) =>
      returnedPath[returnedPath.length - suffix.length + index] === part
  );

const isReviewedDeferredArgumentInvocation = (
  reviewedClosure,
  localName,
  returnedPath
) =>
  reviewedClosure?.deferredArgumentInvocations?.some(
    (policy) =>
      policy.localName === localName &&
      (Object.hasOwn(policy, 'returnedPath')
        ? JSON.stringify(policy.returnedPath) === JSON.stringify(returnedPath)
        : Array.isArray(returnedPath) &&
          cloudflareReturnedPathEndsWith(
            returnedPath,
            policy.returnedPathSuffix
          ))
  ) === true;

const cloudflareReviewedOpaqueDataPolicy = (
  reviewedClosure,
  localName,
  returnedPath,
  dataIndex
) =>
  reviewedClosure?.opaqueDataArgumentInvocations?.find(
    (policy) =>
      policy.localName === localName &&
      policy.dataIndex === dataIndex &&
      JSON.stringify(policy.returnedPath) === JSON.stringify(returnedPath)
  );

const cloudflareOriginCallableParametersAreSafe = (origin) => {
  if (typeof origin.callableParameterSafetyProven === 'boolean') {
    return origin.callableParameterSafetyProven;
  }
  const program = origin.callableParameterProgram;
  if (!program) return false;
  const lexicalContext = createCloudflareLexicalContext(
    program,
    'reviewed-callable-parameters.fixture.js'
  );
  const context = { lexicalContext, program };
  const candidates = cloudflareOriginCallableParameterCandidates(
    origin,
    lexicalContext
  );
  const safe = cloudflareCallableCandidatesHaveSafeParameters(
    candidates,
    context
  );
  origin.callableParameterSafetyProven = safe;
  return safe;
};

const cloudflareOriginCallableParameterCandidates = (origin, lexicalContext) =>
  origin.callableParameterCandidates ??
  (origin.callableParameterSources ?? []).flatMap((source) =>
    cloudflareLexicalTargetCandidates(source, source, lexicalContext)
  );

const cloudflareReviewedOpaqueDataArgumentIsSafe = (
  reviewedClosure,
  localName,
  returnedPath,
  dataIndex,
  opaqueIndexes,
  origins
) => {
  const policy = cloudflareReviewedOpaqueDataPolicy(
    reviewedClosure,
    localName,
    returnedPath,
    dataIndex
  );
  if (!policy) return false;
  const transformerIndexes = [...opaqueIndexes].filter(
    (index) => index >= policy.transformerStartIndex
  );
  return (
    transformerIndexes.length > 0 &&
    transformerIndexes.every((index) => {
      const transformerOrigins = origins.get(index) ?? [];
      return (
        transformerOrigins.length > 0 &&
        transformerOrigins.every(cloudflareOriginCallableParametersAreSafe)
      );
    })
  );
};

const cloudflareImportedFactoryIdentityMatches = (left, right) =>
  ['factoryCallKey', 'importedName', 'localName', 'source'].every(
    (key) => left?.[key] !== undefined && left[key] === right?.[key]
  );

const cloudflareImportedFactoryIdentityKey = (invocation) => {
  const values = ['factoryCallKey', 'importedName', 'localName', 'source'].map(
    (key) => invocation?.[key]
  );
  return values.every((value) => value !== undefined)
    ? JSON.stringify(values)
    : undefined;
};

const cloudflareReturnedPathIsPrefix = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length <= right.length &&
  left.every(
    (part, index) => JSON.stringify(part) === JSON.stringify(right[index])
  );

const cloudflareSameImportedFactoryOrigin = (left, right) =>
  cloudflareImportedFactoryIdentityMatches(left, right) &&
  cloudflareReturnedPathIsPrefix(left.returnedPath, right.returnedPath);

const cloudflareTopLevelVariableDeclarators = (program) =>
  program.body.flatMap((statement) => {
    const declaration = new Set([
      'ExportDefaultDeclaration',
      'ExportNamedDeclaration',
    ]).has(nodeType(statement))
      ? statement.declaration
      : statement;
    return nodeType(declaration) === 'VariableDeclaration'
      ? declaration.declarations
      : [];
  });

const cloudflareReviewedReceiverOriginsByIdentity = (program, bindings) => {
  const originsByIdentity = new Map();
  cloudflareTopLevelVariableDeclarators(program).forEach((declarator) => {
    if (!declarator.init) return;
    const origin = importedCloudflareFactoryResultInvocation(
      program,
      declarator.init,
      bindings
    );
    const identity = cloudflareImportedFactoryIdentityKey(origin);
    if (!identity) return;
    const entries = originsByIdentity.get(identity) ?? [];
    entries.push({ names: bindingNames(declarator.id), origin });
    originsByIdentity.set(identity, entries);
  });
  return originsByIdentity;
};

const cloudflareDirectReviewedReceiverRoots = (invocation, index) => {
  const identity = cloudflareImportedFactoryIdentityKey(invocation);
  return new Set(
    (index.originsByIdentity.get(identity) ?? []).flatMap(({ names, origin }) =>
      cloudflareSameImportedFactoryOrigin(origin, invocation) ? names : []
    )
  );
};

const cloudflareReviewedReceiverWrappedTargets = (target) => [
  target.argument ?? target.expression,
];

const cloudflareReviewedReceiverAssignmentTargets = (target) =>
  target.operator === '=' ? [target.right] : [];

const cloudflareReviewedReceiverConditionalTargets = (target) => {
  const test = cloudflareStaticValue(target.test);
  return test === unknownCloudflareStaticValue
    ? [target.consequent, target.alternate]
    : [test ? target.consequent : target.alternate];
};

const cloudflareReviewedReceiverLogicalTargets = (target) => {
  const reachableSide = cloudflareLogicalReachableSide(target);
  return reachableSide ? [target[reachableSide]] : [target.left, target.right];
};

const cloudflareReviewedReceiverObjectTargets = (target) =>
  target.properties.flatMap((property) =>
    nodeType(property) === 'Property' &&
    property.kind === 'init' &&
    !property.method
      ? [property.value]
      : []
  );

const cloudflareReviewedReceiverContainerTargetReaders = {
  ArrayExpression: (target) => target.elements.filter(Boolean),
  AssignmentExpression: cloudflareReviewedReceiverAssignmentTargets,
  AwaitExpression: cloudflareReviewedReceiverWrappedTargets,
  ChainExpression: cloudflareReviewedReceiverWrappedTargets,
  ConditionalExpression: cloudflareReviewedReceiverConditionalTargets,
  LogicalExpression: cloudflareReviewedReceiverLogicalTargets,
  MemberExpression: () => [],
  ObjectExpression: cloudflareReviewedReceiverObjectTargets,
  ParenthesizedExpression: cloudflareReviewedReceiverWrappedTargets,
  SequenceExpression: (target) => [target.expressions.at(-1)],
};

const cloudflareReviewedReceiverContainerTargets = (target) =>
  cloudflareReviewedReceiverContainerTargetReaders[nodeType(target)]?.(
    target
  ) ?? [];

const cloudflareReviewedReceiverContainerIdentifiers = (target, budget) => {
  const identifiers = new Set();
  cloudflareBoundedTargetSome(
    target,
    (current) => {
      if (nodeType(current) === 'Identifier') {
        identifiers.add(current.name);
      }
      return { targets: cloudflareReviewedReceiverContainerTargets(current) };
    },
    budget
  );
  return identifiers;
};

const cloudflareReviewedReceiverReverseDependencies = (program, budget) => {
  const reverseDependencies = new Map();
  cloudflareTopLevelVariableDeclarators(program).forEach((declarator) => {
    if (!declarator.init) return;
    const declaredNames = bindingNames(declarator.id);
    const dependencies = cloudflareReviewedReceiverContainerIdentifiers(
      declarator.init,
      budget
    );
    dependencies.forEach((dependency) => {
      budget.work += declaredNames.length;
      assert(
        budget.work <= cloudflareAnalysisWorkLimit,
        cloudflareAnalysisWorkMessage
      );
      const dependents = reverseDependencies.get(dependency) ?? [];
      declaredNames.forEach((name) => dependents.push(name));
      reverseDependencies.set(dependency, dependents);
    });
  });
  return reverseDependencies;
};

const cloudflareExpandReviewedReceiverRoots = (reverseDependencies, roots) => {
  const pending = [...roots];
  let work = 0;
  while (pending.length > 0) {
    const dependency = pending.pop();
    const dependents = reverseDependencies.get(dependency) ?? [];
    work += dependents.length;
    assert(work <= cloudflareAnalysisWorkLimit, cloudflareAnalysisWorkMessage);
    dependents.forEach((name) => {
      if (roots.has(name)) return;
      roots.add(name);
      pending.push(name);
    });
  }
  return roots;
};

const cloudflareReviewedReceiverProgramIndexes = new WeakMap();
const cloudflareReviewedReceiverProgramIndex = (program) => {
  const cached = cloudflareReviewedReceiverProgramIndexes.get(program);
  if (cached) return cached;
  const bindings = cloudflareTopLevelBindings(program);
  const budget = { work: 0 };
  const index = {
    bindings,
    originsByIdentity: cloudflareReviewedReceiverOriginsByIdentity(
      program,
      bindings
    ),
    reverseDependencies: cloudflareReviewedReceiverReverseDependencies(
      program,
      budget
    ),
  };
  cloudflareReviewedReceiverProgramIndexes.set(program, index);
  return index;
};

const cloudflareReviewedReceiverRoots = (program, invocation) => {
  const index = cloudflareReviewedReceiverProgramIndex(program);
  const roots = cloudflareDirectReviewedReceiverRoots(invocation, index);
  cloudflareExpandReviewedReceiverRoots(index.reverseDependencies, roots);
  roots.add(invocation.localName);
  return roots;
};

// Narrow test seam for receiver identity and mutation regressions. Production
// verification reaches the same helpers through imported load-effect analysis.
export const inspectCloudflareReviewedReceiverMutationsForTesting = (
  source
) => {
  const program = parseModuleSource(
    'reviewed-receiver.fixture.js',
    source
  ).program;
  const bindings = cloudflareTopLevelBindings(program);
  const states = [];
  new Visitor({
    CallExpression(node) {
      const invocation = importedCloudflareFactoryResultInvocation(
        program,
        node.callee,
        bindings
      );
      if (!invocation?.factoryCallKey) return;
      const roots = cloudflareReviewedReceiverRoots(program, invocation);
      states.push({
        callee: source.slice(node.callee.start, node.callee.end),
        roots: [...roots].toSorted(compareCodePointStrings),
        unmutated: cloudflareReturnedOwnersAreUnmutated(program, roots),
      });
    },
  }).visit(program);
  return states;
};

const cloudflareReturnedPathMatches = (returnedPath, expected) =>
  JSON.stringify(returnedPath) === JSON.stringify(expected);

const isReviewedCreateFileRouteInvocation = (
  ownerLocalName,
  invocation,
  reviewed
) =>
  reviewed &&
  ownerLocalName === 'createFileRoute' &&
  cloudflareReturnedPathMatches(invocation.returnedPath, []);

const isReviewedCreateServerFnInvocation = (
  ownerLocalName,
  invocation,
  reviewed
) =>
  reviewed &&
  ownerLocalName === 'createServerFn' &&
  [['handler'], ['validator'], ['validator', 'handler']].some((path) =>
    cloudflareReturnedPathMatches(invocation.returnedPath, path)
  );

const reviewedDeferredInvocationKindIsAllowed = (
  ownerLocalName,
  invocation,
  reviewed,
  reviewedDelegation
) =>
  [
    isReviewedCreateFileRouteInvocation(ownerLocalName, invocation, reviewed),
    isReviewedCreateServerFnInvocation(ownerLocalName, invocation, reviewed),
    reviewedDelegation,
  ].includes(true);

const isSafeReviewedDeferredInvocation = (
  program,
  invocation,
  ownerLocalName,
  reviewedClosure,
  artifactRoot,
  factoryArgumentOrigins
) => {
  const reviewed = isReviewedDeferredArgumentInvocation(
    reviewedClosure,
    ownerLocalName,
    invocation.returnedPath
  );
  const receiversUnmutated = cloudflareReturnedOwnersAreUnmutated(
    program,
    cloudflareReviewedReceiverRoots(program, invocation)
  );
  const reviewedDelegation = isReviewedDelegatedArgumentInvocation(
    reviewedClosure,
    ownerLocalName,
    invocation.returnedPath,
    factoryArgumentOrigins,
    artifactRoot
  );
  if ((invocation.deferredArgumentHazardIndexes?.length ?? 0) > 0) {
    return false;
  }
  if (!receiversUnmutated) return false;
  return reviewedDeferredInvocationKindIsAllowed(
    ownerLocalName,
    invocation,
    reviewed,
    reviewedDelegation
  );
};

const reviewedCloudflareClosureForFile = (artifactRoot, ownerFile, label) => {
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    ownerFile,
    label
  );
  return reviewedCloudflareNonAppClosure(
    cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord)
  );
};

const isReviewedDelegatedArgumentInvocation = (
  reviewedClosure,
  localName,
  returnedPath,
  factoryArgumentOrigins,
  artifactRoot
) => {
  if (!Array.isArray(returnedPath) || returnedPath.length !== 1) return false;
  const [member] = returnedPath;
  if (typeof member !== 'string') return false;
  return (
    reviewedClosure?.delegatedFactoryArguments?.some((policy) => {
      if (policy.localName !== localName) return false;
      const origins = factoryArgumentOrigins.filter(
        (origin) => origin.index === policy.index
      );
      return (
        origins.length > 0 &&
        origins.every((origin) =>
          reviewedCloudflareClosureForFile(
            artifactRoot,
            origin.ownerFile,
            'delegated factory argument owner'
          )?.deferredMemberInvocations?.includes(member)
        )
      );
    }) === true
  );
};

const cloudflareLoadEffectStateFor = (chunkFile, parsedProgram, visited) => {
  const realFile = fs.realpathSync(chunkFile);
  const existing = visited.get(realFile);
  if (existing) return existing;
  const parsedModule = cloudflareLoadEffectModule(chunkFile, parsedProgram);
  const state = {
    analyzed: false,
    invokedFunctionKeys: new Set(),
    invokedNames: new Set(),
    ...parsedModule,
  };
  visited.set(realFile, state);
  return state;
};

const cloudflareLoadEffectAnalysis = (
  program,
  initiallyInvoked,
  initiallyInvokedReturns,
  manifestRecord,
  forceDeep = false,
  initiallyInvokedFunctionKeys = []
) => {
  const provenance = cloudflareManifestChunkRecord(
    manifestRecord.key,
    manifestRecord
  );
  const ownership = provenance.ownership;
  if (forceDeep && isReviewedCloudflareNonAppClosure(provenance)) {
    return {
      bindings: cloudflareTopLevelBindings(program),
      importedInvocations: new Map(),
      invokedFunctions: new Set(),
      ownerContext: {
        functionOwners: new WeakMap(),
        parentNodes: createAstParentMap(program),
        program,
      },
      shallow: true,
    };
  }
  if (forceDeep || ownership === 'app-only') {
    return dormantCloudflareFunctionRanges(
      program,
      initiallyInvoked,
      initiallyInvokedReturns,
      manifestRecord.entry.file,
      initiallyInvokedFunctionKeys,
      manifestRecord.artifactRoot
    );
  }
  recordShallowScannedCloudflareOutput(
    manifestRecord,
    initiallyInvoked,
    initiallyInvokedReturns,
    initiallyInvokedFunctionKeys
  );
  return {
    bindings: cloudflareTopLevelBindings(program),
    importedInvocations: new Map(),
    invokedFunctions: new Set(),
    ownerContext: {
      functionOwners: new WeakMap(),
      parentNodes: createAstParentMap(program),
      program,
    },
    shallow: true,
  };
};

const cloudflareLoadEffectOwnerContext = (analysis) =>
  analysis.ownerContext ?? analysis.lexicalContext;

const isActiveCloudflareLoadEffectOwner = (owner, ownerContext, analysis) =>
  owner === ownerContext.program || analysis.invokedFunctions.has(owner);

const isShallowCloudflareLoadEffect = (node, target, effectNames, bindings) => {
  if (isCloudflareObjectPropertyDefinition(target, bindings)) {
    return !isCloudflareStaticValueDescriptor({ target: node.arguments?.[2] });
  }
  return isCloudflareLoadEffectTarget(target, effectNames, bindings);
};

const isDetectedCloudflareLoadEffect = (
  node,
  target,
  effectNames,
  analysis
) => {
  if (
    isCloudflareDirectProxyConstruction(
      node,
      cloudflareLoadEffectOwnerContext(analysis),
      analysis.bindings
    )
  ) {
    return false;
  }
  return analysis.shallow
    ? isShallowCloudflareLoadEffect(
        node,
        target,
        effectNames,
        analysis.bindings
      )
    : isCloudflareLoadEffectTargetAt(
        node,
        target,
        effectNames,
        analysis.lexicalContext
      );
};

const recordCloudflareLoadEffect = (
  effects,
  node,
  target,
  effectNames,
  analysis
) => {
  const ownerContext = cloudflareLoadEffectOwnerContext(analysis);
  if (isStaticallyUnreachableCloudflareNode(node, ownerContext)) return;
  const owner = cloudflareFunctionOwnerAt(node, ownerContext);
  if (!isActiveCloudflareLoadEffectOwner(owner, ownerContext, analysis)) return;
  if (isDetectedCloudflareLoadEffect(node, target, effectNames, analysis)) {
    effects.push(node);
  }
};

const cloudflareLoadEffects = (program, analysis) => {
  assertNoCloudflareSpreadAccessors(program, analysis);
  const effects = [];
  const record = (node, target, effectNames) =>
    recordCloudflareLoadEffect(effects, node, target, effectNames, analysis);
  new Visitor({
    CallExpression(node) {
      record(node, node.callee, cloudflareLoadEffectCalls);
    },
    NewExpression(node) {
      record(node, node.callee, cloudflareLoadEffectConstructors);
    },
    TaggedTemplateExpression(node) {
      record(node, node.tag, cloudflareLoadEffectCalls);
    },
  }).visit(program);
  return effects;
};

// Narrow test seam for positional parameter propagation regressions. Production
// verification reaches the same helpers through emitted chunk analysis.
export const inspectCloudflareLoadEffectsForTesting = (source) => {
  const analysisLabel = 'load-effects.fixture.js';
  const program = parseModuleSource(analysisLabel, source).program;
  const analysis = dormantCloudflareFunctionRanges(
    program,
    [],
    [],
    analysisLabel
  );
  return cloudflareLoadEffects(program, analysis).map((effect) =>
    source.slice(effect.start, effect.end)
  );
};

const assertNoCloudflareSpreadAccessors = (program, analysis) => {
  if (analysis.shallow) return;
  const context = analysis.lexicalContext;
  const ownerContext = cloudflareLoadEffectOwnerContext(analysis);
  new Visitor({
    SpreadElement(spread) {
      if (isStaticallyUnreachableCloudflareNode(spread, ownerContext)) return;
      const parentType = nodeType(context.parentNodes.get(spread));
      if (!new Set(['ArrayExpression', 'ObjectExpression']).has(parentType))
        return;
      const owner = cloudflareFunctionOwnerAt(spread, ownerContext);
      if (!isActiveCloudflareLoadEffectOwner(owner, ownerContext, analysis)) {
        return;
      }
      const expectedType = parentType;
      const targets = cloudflareAggregateSpreadTargets(
        spread,
        context,
        expectedType,
        new Set()
      );
      if (expectedType === 'ObjectExpression') {
        targets.forEach(({ target }) =>
          cloudflareSpreadObjectProperties(target)
        );
        return;
      }
      assert(
        targets.every(({ target }) =>
          target.elements.every(
            (element) =>
              element?.cloudflareOpaqueSpreadElement !== true ||
              element?.cloudflareSafeOpaqueSpreadIteration === true
          )
        ),
        `${cloudflareOpaqueAggregateSpreadMessage} executes in ${context.analysisLabel}`
      );
    },
  }).visit(program);
};

const assertNoDetectedCloudflareLoadEffects = (
  effects,
  chunkFile,
  chunkSource
) => {
  const firstEffect = effects[0];
  const diagnostic = firstEffect
    ? ` (${chunkSource.slice(firstEffect.start, firstEffect.end).slice(0, 240)})`
    : '';
  assert(
    effects.length === 0,
    `${chunkFile} must not execute fetch, eval, or worker effects while loading${diagnostic}`
  );
};

const assertCloudflareImportedLoadEffectOwners = (
  program,
  chunkFile,
  artifactRoot,
  importedInvocations,
  visited
) => {
  const message = `${chunkFile} must preserve imported load-effect ownership`;
  const importedGroups = groupCloudflareImportedInvocations(
    program,
    importedInvocations.values(),
    message
  );
  for (const [source, invocations] of importedGroups) {
    if (!source?.startsWith('.')) {
      assert(reviewedCloudflareClosureExternals.has(source), message);
      continue;
    }
    const owner = cloudflareImportedOwner(
      program,
      chunkFile,
      invocations,
      artifactRoot,
      message,
      visited
    );
    const opaqueArgumentReturns =
      cloudflareOpaqueImportedArgumentReturnedInvocations(
        owner.ownerProgram,
        owner.opaqueArgumentInvocations,
        normalizeArtifactFile(artifactRoot, owner.ownerFile),
        owner.reviewedClosure
      );
    const opaqueInvocationsByOwner = new Map();
    opaqueArgumentReturns.forEach(
      ({ invocation, localFunctionKeys = [], ownerFile }) => {
        const values = opaqueInvocationsByOwner.get(ownerFile) ?? {
          functionKeys: [],
          returns: [],
        };
        if (invocation) values.returns.push(invocation);
        values.functionKeys.push(...localFunctionKeys);
        opaqueInvocationsByOwner.set(ownerFile, values);
      }
    );
    opaqueInvocationsByOwner.forEach(({ functionKeys, returns }, ownerFile) => {
      assertNoCloudflareStaticChunkLoadEffects(
        ownerFile,
        artifactRoot,
        [],
        visited,
        undefined,
        false,
        returns,
        functionKeys
      );
    });
    assertNoCloudflareStaticChunkLoadEffects(
      owner.ownerFile,
      artifactRoot,
      owner.localNames,
      visited,
      undefined,
      false,
      owner.returnedInvocations
    );
  }
};

const cloudflareCanonicalIndexes = (indexes) =>
  Array.isArray(indexes)
    ? [...indexes].toSorted((left, right) => left - right)
    : null;

const cloudflareReturnedInvocationKey = (invocation) =>
  JSON.stringify({
    factoryArgumentCount: cloudflareKeyValue(
      invocation.factoryArgumentCount,
      null
    ),
    factoryCaptureResolutionProven: cloudflareKeyValue(
      invocation.factoryCaptureResolutionProven,
      false
    ),
    factoryCallableArgumentIndexes: cloudflareCanonicalIndexes(
      invocation.factoryCallableArgumentIndexes
    ),
    factoryResolvedArgumentIndexes: cloudflareCanonicalIndexes(
      invocation.factoryResolvedArgumentIndexes
    ),
    localName: invocation.localName,
    reviewedFactoryOrigin: cloudflareKeyValue(
      invocation.reviewedFactoryOrigin,
      false
    ),
    returnedPath: invocation.returnedPath,
  });

const parseCloudflareReturnedInvocationKey = (key) => JSON.parse(key);

const updateCloudflareLoadEffectInvocations = (
  state,
  initiallyInvoked,
  initiallyInvokedReturns,
  initiallyInvokedFunctionKeys,
  forceDeep
) => {
  state.invokedFunctionKeys ??= new Set();
  state.invokedReturns ??= new Set();
  const newFunctionKeys = initiallyInvokedFunctionKeys.filter(
    (key) => !state.invokedFunctionKeys.has(key)
  );
  const newNames = initiallyInvoked.filter(
    (name) => !state.invokedNames.has(name)
  );
  const newReturns = initiallyInvokedReturns.filter(
    (invocation) =>
      !state.invokedReturns.has(cloudflareReturnedInvocationKey(invocation))
  );
  const forceDeepUpgrade = forceDeep && state.forceDeep !== true;
  const changed = [
    !state.analyzed,
    forceDeepUpgrade,
    newFunctionKeys.length > 0,
    newNames.length > 0,
    newReturns.length > 0,
  ].includes(true);
  if (forceDeepUpgrade) state.forceDeep = true;
  newNames.forEach((name) => state.invokedNames.add(name));
  newFunctionKeys.forEach((key) => state.invokedFunctionKeys.add(key));
  newReturns.forEach((invocation) =>
    state.invokedReturns.add(cloudflareReturnedInvocationKey(invocation))
  );
  return {
    changed,
    factsAdded:
      newFunctionKeys.length +
      newNames.length +
      newReturns.length +
      (forceDeepUpgrade ? 1 : 0),
  };
};

const cloudflareLoadEffectInvocationState = (state) => ({
  functionKeys: [...state.invokedFunctionKeys],
  names: [...state.invokedNames],
  returns: [...state.invokedReturns].map(parseCloudflareReturnedInvocationKey),
});

const cloudflareLoadEffectCoordinatorLimits = Object.freeze({
  facts: 100_000,
  modules: 10_000,
  pendingFacts: 100_000,
  revisions: 100_000,
  tasks: 200_000,
});
const cloudflareLoadEffectCoordinators = new WeakMap();

const cloudflareLoadEffectCoordinatorFor = (visited) => {
  const existing = cloudflareLoadEffectCoordinators.get(visited);
  if (existing) return existing;
  const coordinator = {
    cursor: 0,
    draining: false,
    facts: 0,
    pending: [],
    pendingByFile: new Map(),
    pendingFacts: 0,
    revisions: 0,
    seenTaskKeys: new Set(),
    tasks: 0,
  };
  cloudflareLoadEffectCoordinators.set(visited, coordinator);
  return coordinator;
};

const assertCloudflareLoadEffectCoordinatorBound = (coordinator, visited) => {
  const { facts, modules, pendingFacts, revisions, tasks } =
    cloudflareLoadEffectCoordinatorLimits;
  assert(
    coordinator.facts <= facts &&
      coordinator.pendingFacts <= pendingFacts &&
      coordinator.revisions <= revisions &&
      coordinator.tasks <= tasks &&
      visited.size <= modules,
    `Cloudflare load-effect analysis exceeded its bounded state (${visited.size} modules, ${coordinator.revisions} revisions, ${coordinator.facts} facts, ${coordinator.pendingFacts} pending facts, ${coordinator.tasks} tasks)`
  );
};

const cloudflareLoadEffectTaskKey = (task) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        file: path.resolve(task.chunkFile),
        forceDeep: task.forceDeep,
        functionKeys: [...new Set(task.initiallyInvokedFunctionKeys)].toSorted(
          compareCodePointStrings
        ),
        names: [...new Set(task.initiallyInvoked)].toSorted(
          compareCodePointStrings
        ),
        returns: [
          ...new Set(
            task.initiallyInvokedReturns.map(cloudflareReturnedInvocationKey)
          ),
        ].toSorted(compareCodePointStrings),
      })
    )
    .digest('hex');

const cloudflareLoadEffectTaskFactCount = (task) =>
  task.initiallyInvoked.length +
  task.initiallyInvokedFunctionKeys.length +
  task.initiallyInvokedReturns.length +
  (task.forceDeep ? 1 : 0);

const mergeCloudflareLoadEffectTask = (existing, incoming) => ({
  ...existing,
  forceDeep: existing.forceDeep || incoming.forceDeep,
  initiallyInvoked: [
    ...new Set([...existing.initiallyInvoked, ...incoming.initiallyInvoked]),
  ],
  initiallyInvokedFunctionKeys: [
    ...new Set([
      ...existing.initiallyInvokedFunctionKeys,
      ...incoming.initiallyInvokedFunctionKeys,
    ]),
  ],
  initiallyInvokedReturns: [
    ...new Map(
      [
        ...existing.initiallyInvokedReturns,
        ...incoming.initiallyInvokedReturns,
      ].map((invocation) => [
        cloudflareReturnedInvocationKey(invocation),
        invocation,
      ])
    ).values(),
  ],
  parsedProgram: existing.parsedProgram ?? incoming.parsedProgram,
});

const enqueueCloudflareLoadEffectTask = (coordinator, task, visited) => {
  const key = cloudflareLoadEffectTaskKey(task);
  if (coordinator.seenTaskKeys.has(key)) return;
  coordinator.seenTaskKeys.add(key);
  coordinator.tasks += 1;
  const fileKey = path.resolve(task.chunkFile);
  const existing = coordinator.pendingByFile.get(fileKey);
  const merged = existing
    ? mergeCloudflareLoadEffectTask(existing, task)
    : task;
  coordinator.pendingFacts +=
    cloudflareLoadEffectTaskFactCount(merged) -
    cloudflareLoadEffectTaskFactCount(
      existing ?? {
        forceDeep: false,
        initiallyInvoked: [],
        initiallyInvokedFunctionKeys: [],
        initiallyInvokedReturns: [],
      }
    );
  coordinator.pendingByFile.set(fileKey, merged);
  if (!existing) coordinator.pending.push(fileKey);
  assertCloudflareLoadEffectCoordinatorBound(coordinator, visited);
};

const analyzeCloudflareStaticChunkLoadEffectTask = (task, coordinator) => {
  const {
    artifactRoot,
    chunkFile,
    forceDeep,
    initiallyInvoked,
    initiallyInvokedFunctionKeys,
    initiallyInvokedReturns,
    parsedProgram,
    visited,
  } = task;
  const state = cloudflareLoadEffectStateFor(chunkFile, parsedProgram, visited);
  const update = updateCloudflareLoadEffectInvocations(
    state,
    initiallyInvoked,
    initiallyInvokedReturns,
    initiallyInvokedFunctionKeys,
    forceDeep
  );
  if (!update.changed) return;
  coordinator.facts += update.factsAdded;
  coordinator.revisions += 1;
  assertCloudflareLoadEffectCoordinatorBound(coordinator, visited);
  state.analyzed = true;
  const { program, source: chunkSource } = state;
  const invocations = cloudflareLoadEffectInvocationState(state);
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    chunkFile,
    'load-effect analysis'
  );
  const analysis = cloudflareLoadEffectAnalysis(
    program,
    invocations.names,
    invocations.returns,
    manifestRecord,
    state.forceDeep === true,
    invocations.functionKeys
  );
  assertNoDetectedCloudflareLoadEffects(
    cloudflareLoadEffects(program, analysis),
    chunkFile,
    chunkSource
  );
  assertCloudflareImportedLoadEffectOwners(
    program,
    chunkFile,
    artifactRoot,
    analysis.importedInvocations,
    visited
  );
};

const drainCloudflareLoadEffectCoordinator = (coordinator, visited) => {
  if (coordinator.draining) return;
  coordinator.draining = true;
  try {
    while (coordinator.cursor < coordinator.pending.length) {
      const fileKey = coordinator.pending[coordinator.cursor];
      coordinator.pending[coordinator.cursor] = undefined;
      coordinator.cursor += 1;
      const task = coordinator.pendingByFile.get(fileKey);
      coordinator.pendingByFile.delete(fileKey);
      if (!task) continue;
      coordinator.pendingFacts -= cloudflareLoadEffectTaskFactCount(task);
      analyzeCloudflareStaticChunkLoadEffectTask(task, coordinator);
      assertCloudflareLoadEffectCoordinatorBound(coordinator, visited);
    }
  } finally {
    coordinator.cursor = 0;
    coordinator.draining = false;
    coordinator.pending.length = 0;
    coordinator.pendingByFile.clear();
    coordinator.pendingFacts = 0;
  }
};

const assertNoCloudflareStaticChunkLoadEffects = (
  chunkFile,
  artifactRoot,
  initiallyInvoked = [],
  visited = new Map(),
  parsedProgram,
  forceDeep = false,
  initiallyInvokedReturns = [],
  initiallyInvokedFunctionKeys = []
) => {
  const coordinator = cloudflareLoadEffectCoordinatorFor(visited);
  enqueueCloudflareLoadEffectTask(
    coordinator,
    {
      artifactRoot,
      chunkFile,
      forceDeep,
      initiallyInvoked,
      initiallyInvokedFunctionKeys,
      initiallyInvokedReturns,
      parsedProgram,
      visited,
    },
    visited
  );
  drainCloudflareLoadEffectCoordinator(coordinator, visited);
};

const cloudflareStaticImportSources = (program) =>
  program.body
    .filter((statement) => statement.type === 'ImportDeclaration')
    .map((statement) => literalString(statement.source));

const cloudflareStaticDependencySources = (program) =>
  program.body
    .filter(
      (statement) =>
        statement.type === 'ImportDeclaration' ||
        ((statement.type === 'ExportAllDeclaration' ||
          statement.type === 'ExportNamedDeclaration') &&
          statement.source !== null)
    )
    .map((statement) => literalString(statement.source));

const cloudflareDynamicImportNodes = (program) => {
  const imports = [];
  new Visitor({
    ImportExpression(importExpression) {
      imports.push(importExpression);
    },
  }).visit(program);
  return imports;
};

const cloudflareDynamicImportSources = (program) =>
  cloudflareDynamicImportNodes(program).map((node) =>
    literalString(node.source)
  );

const assertExactCloudflareStaticImportSources = (
  program,
  chunkFile,
  sourcePatterns
) => {
  const sources = cloudflareStaticImportSources(program);
  assert(
    sources.length === sourcePatterns.length &&
      sources.every((source, index) =>
        sourcePatterns[index].test(source ?? '')
      ),
    `${chunkFile} must import only its trusted static owner chunks`
  );
};

const cloudflareRelativeArtifactLink = (
  chunkFile,
  source,
  manifestRecord,
  realArtifactRoot,
  message
) => {
  const linkedFile = path.resolve(path.dirname(chunkFile), source);
  assert(isWithinDirectory(linkedFile, manifestRecord.artifactRoot), message);
  assertFile(linkedFile);
  assert(
    isWithinDirectory(fs.realpathSync(linkedFile), realArtifactRoot),
    message
  );
  return {
    artifactFile: normalizeArtifactFile(
      manifestRecord.artifactRoot,
      linkedFile
    ),
    linkedFile,
  };
};

const assertExactCloudflareStaticImports = (
  program,
  chunkFile,
  manifestRecord,
  loadEffectVisited = new Map(),
  scanLinkedLoadEffects = true
) => {
  const message = `${chunkFile} must preserve its exact Vite static import graph`;
  const importKeys = manifestRecord.entry.imports ?? [];
  assert(Array.isArray(importKeys), message);
  const expectedFiles = manifestFilesForKeys(
    manifestRecord,
    importKeys,
    message
  );
  const sources = cloudflareStaticImportSources(program);
  const relativeSources = sources.filter((source) => source?.startsWith('./'));
  assert(
    sources.every(
      (source) =>
        source?.startsWith('./') ||
        reviewedCloudflareClosureExternals.has(source)
    ),
    message
  );
  const realArtifactRoot = fs.realpathSync(manifestRecord.artifactRoot);
  const links = relativeSources.map((source) =>
    cloudflareRelativeArtifactLink(
      chunkFile,
      source,
      manifestRecord,
      realArtifactRoot,
      message
    )
  );
  const linkedFiles = links.map(({ linkedFile }) => linkedFile);
  const actualFiles = links.map(({ artifactFile }) => artifactFile);
  assert(exactSortedValues(actualFiles, expectedFiles), message);
  if (scanLinkedLoadEffects) {
    linkedFiles.forEach((linkedFile) => {
      assertNoCloudflareStaticChunkLoadEffects(
        linkedFile,
        manifestRecord.artifactRoot,
        [],
        loadEffectVisited
      );
    });
  }
  return linkedFiles;
};

const isReviewedCloudflareDynamicSource = (source) =>
  source === undefined ||
  source.startsWith('./') ||
  reviewedCloudflareClosureExternals.has(source);

const assertExactCloudflareDynamicImports = (
  program,
  chunkFile,
  manifestRecord,
  loadEffectVisited = new Map(),
  scanLinkedLoadEffects = true
) => {
  const message = `${chunkFile} must preserve its exact Vite dynamic import graph`;
  const allDynamicKeys = manifestRecord.entry.dynamicImports ?? [];
  assert(isStringArray(allDynamicKeys), message);
  const dynamicKeys = allDynamicKeys.filter(
    (key) => !isAppOwnedCloudflareManifestKey(key, manifestRecord)
  );
  const expectedFiles = manifestFilesForKeys(
    manifestRecord,
    dynamicKeys,
    message
  );
  const sources = cloudflareDynamicImportSources(program);
  const relativeSources = sources.filter((source) => source?.startsWith('./'));
  assert(sources.every(isReviewedCloudflareDynamicSource), message);
  const realArtifactRoot = fs.realpathSync(manifestRecord.artifactRoot);
  const linkedFiles = relativeSources.map(
    (source) =>
      cloudflareRelativeArtifactLink(
        chunkFile,
        source,
        manifestRecord,
        realArtifactRoot,
        message
      ).linkedFile
  );
  const reviewedLinkedFiles = linkedFiles.filter((linkedFile) => {
    const linkedRecord = assertCloudflareChunkManifestMembership(
      manifestRecord.artifactRoot,
      linkedFile,
      message
    );
    return !isAppOwnedCloudflareManifestKey(linkedRecord.key, linkedRecord);
  });
  const actualFiles = reviewedLinkedFiles.map((linkedFile) =>
    normalizeArtifactFile(manifestRecord.artifactRoot, linkedFile)
  );
  assert(exactSortedValues([...new Set(actualFiles)], expectedFiles), message);
  if (scanLinkedLoadEffects) {
    linkedFiles.forEach((linkedFile) => {
      assertNoCloudflareStaticChunkLoadEffects(
        linkedFile,
        manifestRecord.artifactRoot,
        [],
        loadEffectVisited
      );
    });
  }
  return linkedFiles;
};

const assertExactCloudflareDependencyGraph = (
  initialChunkFile,
  artifactRoot,
  loadEffectVisited,
  dependencyVisited = new Set()
) => {
  const pending = [initialChunkFile];
  while (pending.length > 0) {
    const chunkFile = pending.pop();
    const visitKey = fs.realpathSync(chunkFile);
    if (dependencyVisited.has(visitKey)) continue;
    dependencyVisited.add(visitKey);
    const manifestRecord = assertCloudflareChunkManifestMembership(
      artifactRoot,
      chunkFile,
      'Cloudflare dependency graph'
    );
    const program = readParsedModule(chunkFile).program;
    assertNoCloudflareStaticChunkLoadEffects(
      chunkFile,
      artifactRoot,
      [],
      loadEffectVisited,
      program
    );
    const appOwned = isAppOwnedCloudflareManifestKey(
      manifestRecord.key,
      manifestRecord
    );
    const children = appOwned
      ? cloudflareManifestDependencyFiles(manifestRecord)
      : [
          ...assertExactCloudflareStaticImports(
            program,
            chunkFile,
            manifestRecord,
            loadEffectVisited,
            false
          ),
          ...assertExactCloudflareDynamicImports(
            program,
            chunkFile,
            manifestRecord,
            loadEffectVisited,
            false
          ),
        ];
    children.forEach((childFile) => {
      const childRecord = assertCloudflareChunkManifestMembership(
        artifactRoot,
        childFile,
        'Cloudflare dependency graph child'
      );
      if (isAppOwnedCloudflareManifestKey(childRecord.key, childRecord)) {
        assertNoCloudflareStaticChunkLoadEffects(
          childFile,
          artifactRoot,
          [],
          loadEffectVisited
        );
      }
      pending.push(childFile);
    });
  }
};

const cloudflareManifestDependencyFiles = (manifestRecord) => {
  const message = `${manifestRecord.manifestFile} must preserve app-owned dependency metadata`;
  const keys = [
    ...(manifestRecord.entry.imports ?? []),
    ...(manifestRecord.entry.dynamicImports ?? []),
  ];
  assert(isStringArray(keys), message);
  return manifestFilesForKeys(manifestRecord, keys, message).map((file) => {
    const childFile = path.resolve(manifestRecord.artifactRoot, file);
    assert(isWithinDirectory(childFile, manifestRecord.artifactRoot), message);
    assertFile(childFile);
    return childFile;
  });
};

const isExactEntryInteropInitializer = (node, dependency) => {
  if (nodeType(node) !== 'CallExpression') return false;
  const [dependencyCall, interopMode] = node.arguments;
  if (nodeType(dependencyCall) !== 'CallExpression') return false;
  if (nodeType(interopMode) !== 'Literal') return false;
  return [
    identifierName(node.callee) === '__toESM',
    node.arguments.length === 2,
    identifierName(dependencyCall.callee) === dependency,
    dependencyCall.arguments.length === 0,
    interopMode.value === 1,
  ].every(Boolean);
};

const exactObservedStreamCalls = [
  'createRequestExceptionCaptureState',
  'createSsrStreamResponse',
  'getRequestExceptionState',
  'isbot',
  'registerRequestCompletion',
  'transformReadableStreamWithRouter',
  'waitForReadyOrAbort',
];

const astField = (node, field) => Reflect.get(Object(node), field);
const astItem = (node, field, index) =>
  Reflect.get(Object(astField(node, field)), String(index));

const exactObservedStreamDeclarator = (statement, localName) => {
  const declarations = astField(statement, 'declarations');
  const declarator = astItem(statement, 'declarations', 0);
  const matches = [
    nodeType(statement) === 'VariableDeclaration',
    astField(statement, 'kind') === 'const',
    astField(declarations, 'length') === 1,
    identifierName(astField(declarator, 'id')) === localName,
  ].every(Boolean);
  return Reflect.get({ true: declarator }, String(matches));
};

const isExactNamedCall = (node, calleeName, argumentNames) => {
  const callArguments = astField(node, 'arguments');
  const actualArguments = argumentNames.map((_, index) =>
    identifierName(astItem(node, 'arguments', index))
  );
  return [
    nodeType(node) === 'CallExpression',
    identifierName(astField(node, 'callee')) === calleeName,
    astField(callArguments, 'length') === argumentNames.length,
    actualArguments.join(':') === argumentNames.join(':'),
  ].every(Boolean);
};

const isObservedStreamTransformCall = (node) => {
  const callArguments = astField(node, 'arguments');
  const argumentCount = astField(callArguments, 'length');
  return [
    nodeType(node) === 'CallExpression',
    identifierName(astField(node, 'callee')) ===
      'transformReadableStreamWithRouter',
    argumentCount === 2 || argumentCount === 3,
    identifierName(astItem(node, 'arguments', 0)) === 'router',
    identifierName(astItem(node, 'arguments', 1)) === 'stream',
    argumentCount === 2 ||
      nodeType(astItem(node, 'arguments', 2)) === 'ObjectExpression',
  ].every(Boolean);
};

const isExactObservedStreamDataflow = (handler) => {
  const statements = handler.body.body;
  const stream = exactObservedStreamDeclarator(statements[1], 'stream');
  const responseStream = exactObservedStreamDeclarator(
    statements[4],
    'responseStream'
  );
  const response = exactObservedStreamDeclarator(statements[5], 'response');
  const returned = statements[6];
  const render = astField(stream, 'init');
  const renderCall = unwrapAwaitExpression(render);
  const renderCallee = astField(renderCall, 'callee');
  const responseInitializer = astField(response, 'init');
  const responseOptions = astItem(responseInitializer, 'arguments', 1);
  const responseOptionProperties = astField(responseOptions, 'properties');
  const headersOption = astItem(responseOptions, 'properties', 0);
  const statusOption = astItem(responseOptions, 'properties', 1);
  const statusCall = astField(statusOption, 'value');
  const statusGetter = astField(statusCall, 'callee');
  const statusCode = astField(statusGetter, 'object');
  const routerStores = astField(statusCode, 'object');
  const returnedArgument = astField(returned, 'argument');
  return [
    nodeType(render) === 'AwaitExpression',
    nodeType(renderCall) === 'CallExpression',
    identifierName(astField(renderCallee, 'object')) === 'import_server_edge',
    identifierName(astField(renderCallee, 'property')) ===
      'renderToReadableStream',
    isObservedStreamTransformCall(astField(responseStream, 'init')),
    nodeType(responseInitializer) === 'NewExpression',
    identifierName(astField(responseInitializer, 'callee')) === 'Response',
    astField(astField(responseInitializer, 'arguments'), 'length') === 2,
    identifierName(astItem(responseInitializer, 'arguments', 0)) ===
      'responseStream',
    nodeType(responseOptions) === 'ObjectExpression',
    astField(responseOptionProperties, 'length') === 2,
    propertyKeyName(headersOption) === 'headers',
    identifierName(astField(headersOption, 'value')) === 'responseHeaders',
    propertyKeyName(statusOption) === 'status',
    nodeType(statusCall) === 'CallExpression',
    astField(astField(statusCall, 'arguments'), 'length') === 0,
    cloudflareMemberName(statusGetter) === 'get',
    cloudflareMemberName(statusCode) === 'statusCode',
    cloudflareMemberName(routerStores) === 'stores',
    identifierName(astField(routerStores, 'object')) === 'router',
    nodeType(returned) === 'ReturnStatement',
    isExactNamedCall(returnedArgument, 'createSsrStreamResponse', [
      'router',
      'response',
    ]),
    astField(astField(returnedArgument, 'arguments'), 'length') === 2,
  ].every(Boolean);
};

const cloudflareTanStackOwnerDigests = Object.freeze({
  createStartHandler:
    'dc012cbcd20bc6b2696eef2a27d81be5205e259b9f75efbcacdf4a9eb63819c4',
  defineHandlerCallback:
    'fc0a6c8a8a043acd7f5663dc017d92e76fc2cc48b4c30de7e3c0975ab8b7d3d9',
  emptyPluginAdaptersChunk:
    'e1e88ab713c682ecc3c074e3db0d0f06be6d13329e037d328f343d1f32ea6463',
  observedStreamHandler:
    '12c050807148475cb72b05be210798a6ed598629567cc254ce9e53e0fcb93b4f',
  routerLocalClosure:
    '104b289a05ffb491127ac7a64eb51f5f7b6cf3024e0e73a09ff3551bada525da',
  serverClosure:
    '9ae59e0b6fed6b31842a1cc68e867041025ff20022f3356eaf5157b5c8b113ef',
  serverEdgeClosure:
    '50d491e50e67b143096bc0abec5efabefb6013cd9341143fd998fd20a3764a48',
  startOwnerClosure:
    '79aef70ecc2d8992fdcd44e17a4b5dc861517ed54ba3e4141363ced1cf7839c6',
});
const ignoredAstDigestKeys = new Set(['end', 'loc', 'raw', 'start']);
const normalizeAstDigestValue = (key, value) => {
  if (ignoredAstDigestKeys.has(key)) return undefined;
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
};
const replaceModuleSourceLiteral = (source, replacement) => {
  if (nodeType(source) === 'Literal' && typeof source.value === 'string') {
    source.value = replacement(source.value);
  }
};
const staticModuleSourceDeclarations = new Set([
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
  'ImportDeclaration',
]);
const normalizeStaticModuleSources = (program, replacement) => {
  if (nodeType(program) !== 'Program') return;
  for (const statement of program.body) {
    if (!staticModuleSourceDeclarations.has(statement.type)) continue;
    replaceModuleSourceLiteral(statement.source, (source) =>
      replacement(source, 'static')
    );
  }
};
const normalizeDynamicModuleSources = (node, replacement) => {
  new Visitor({
    ImportExpression(importExpression) {
      replaceModuleSourceLiteral(importExpression.source, (source) =>
        replacement(source, 'dynamic')
      );
    },
  }).visit(node);
};
const normalizeAstModuleSources = (node, replacement) => {
  const normalized = structuredClone(node);
  normalizeStaticModuleSources(normalized, replacement);
  normalizeDynamicModuleSources(normalized, replacement);
  return normalized;
};
const astDigest = (node, moduleSourceReplacement) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        moduleSourceReplacement
          ? normalizeAstModuleSources(node, moduleSourceReplacement)
          : node,
        normalizeAstDigestValue
      )
    )
    .digest('hex');
const reviewedCloudflareClosureExternals = new Set([
  'async_hooks',
  'crypto',
  'dns',
  'events',
  'fs',
  'net',
  'node:async_hooks',
  'node:crypto',
  'node:events',
  'node:module',
  'node:net',
  'node:perf_hooks',
  'node:readline',
  'node:stream',
  'node:stream/web',
  'path',
  'stream',
  'string_decoder',
  'tls',
  'util',
  'util/types',
  'cloudflare:sockets',
]);
const isObjectRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const normalizedManifestChunkFile = (file) =>
  file.replace(/-[-_A-Za-z0-9]{8}(?=\.js$)/u, '');

const manifestEntryOwner = (key, entry) =>
  typeof entry.src === 'string'
    ? `src:${entry.src}`
    : typeof entry.name === 'string'
      ? `name:${entry.name}`
      : `file:${normalizedManifestChunkFile(entry.file ?? key)}`;

const manifestDependencyIdentities = (manifest, keys, message) => {
  assert(isStringArray(keys), message);
  return keys
    .map((key) => {
      const dependency = manifest[key];
      assert(isObjectRecord(dependency), message);
      assert(typeof dependency.file === 'string', message);
      return JSON.stringify([
        manifestEntryOwner(key, dependency),
        path.posix.dirname(dependency.file),
      ]);
    })
    .toSorted(compareCodePointStrings);
};

const manifestNodeIdentityCache = new WeakMap();

const cachedManifestNodeIdentity = (manifest, key) =>
  manifestNodeIdentityCache.get(manifest)?.get(key);

const cacheManifestNodeIdentity = (manifest, key, identity) => {
  let identities = manifestNodeIdentityCache.get(manifest);
  if (!identities) {
    identities = new Map();
    manifestNodeIdentityCache.set(manifest, identities);
  }
  identities.set(key, identity);
  return identity;
};

const generatedManifestNodeIdentity = (base, entry, manifest, message) =>
  JSON.stringify([
    ...base,
    {
      dynamicImports: manifestDependencyIdentities(
        manifest,
        entry.dynamicImports ?? [],
        message
      ),
      imports: manifestDependencyIdentities(
        manifest,
        entry.imports ?? [],
        message
      ),
    },
  ]);

const createManifestNodeIdentity = (key, entry, manifest, message) => {
  assert(isObjectRecord(entry), message);
  assert(typeof entry.file === 'string', message);
  const owner = manifestEntryOwner(key, entry);
  const base = [owner, path.posix.dirname(entry.file)];
  if (typeof entry.src === 'string') return JSON.stringify(base);
  return generatedManifestNodeIdentity(base, entry, manifest, message);
};

const manifestNodeIdentity = (key, entry, manifest, message) => {
  const cachedIdentity = cachedManifestNodeIdentity(manifest, key);
  if (cachedIdentity !== undefined) return cachedIdentity;
  return cacheManifestNodeIdentity(
    manifest,
    key,
    createManifestNodeIdentity(key, entry, manifest, message)
  );
};

const manifestRecordNodeIdentity = (manifestRecord, key, message) => {
  const entry = manifestRecord.manifest[key];
  assert(entry, message);
  return manifestNodeIdentity(key, entry, manifestRecord.manifest, message);
};
// App implementation remains governed by source checks; artifact digests pin the
// stable boundary without forcing a digest refresh for ordinary application edits.
// The boundary is emitted by the trusted Vite build hook from Rollup's resolved
// module IDs and is bound to the exact emitted chunk bytes.
const cloudflareAppChunkProvenanceCache = new Map();
const validatedCloudflareAppChunkRecords = new WeakMap();
const reviewedCloudflareOutputFiles = new Set();
const shallowScannedCloudflareOutputFiles = new Map();
const shallowScannedCloudflareOutputQueue = [];

const cloudflareManifestChunkFile = (manifestRecord) =>
  fs.realpathSync(
    path.resolve(manifestRecord.artifactRoot, manifestRecord.entry.file)
  );

const recordReviewedCloudflareManifestKeys = (keys, manifestRecord) => {
  keys.forEach((key) => {
    const entry = manifestRecord.manifest[key];
    assert(isObjectRecord(entry) && typeof entry.file === 'string', key);
    reviewedCloudflareOutputFiles.add(
      fs.realpathSync(path.resolve(manifestRecord.artifactRoot, entry.file))
    );
  });
};

const recordShallowScannedCloudflareOutput = (
  manifestRecord,
  initiallyInvoked,
  initiallyInvokedReturns,
  initiallyInvokedFunctionKeys
) => {
  const file = cloudflareManifestChunkFile(manifestRecord);
  const isNewFile = !shallowScannedCloudflareOutputFiles.has(file);
  const existing = cloudflareShallowScanState(manifestRecord, file);
  const previousInvocationCount =
    existing.invokedFunctionKeys.size +
    existing.invokedNames.size +
    existing.invokedReturns.size;
  initiallyInvoked.forEach((name) => existing.invokedNames.add(name));
  initiallyInvokedReturns.forEach((invocation) =>
    existing.invokedReturns.add(cloudflareReturnedInvocationKey(invocation))
  );
  initiallyInvokedFunctionKeys.forEach((key) =>
    existing.invokedFunctionKeys.add(key)
  );
  const invocationCount =
    existing.invokedFunctionKeys.size +
    existing.invokedNames.size +
    existing.invokedReturns.size;
  if ([isNewFile, invocationCount !== previousInvocationCount].includes(true)) {
    existing.revision += 1;
    shallowScannedCloudflareOutputQueue.push(file);
  }
  shallowScannedCloudflareOutputFiles.set(file, existing);
};

const cloudflareShallowScanState = (manifestRecord, file) => {
  const existing = shallowScannedCloudflareOutputFiles.get(file);
  if (existing) {
    existing.invokedFunctionKeys ??= new Set();
    existing.invokedReturns ??= new Set();
    return existing;
  }
  return {
    artifactRoot: fs.realpathSync(manifestRecord.artifactRoot),
    invokedFunctionKeys: new Set(),
    invokedNames: new Set(),
    invokedReturns: new Set(),
    revision: 0,
  };
};

const shouldReviewCloudflareShallowState = (file, state, processedRevision) =>
  !reviewedCloudflareOutputFiles.has(file) &&
  (processedRevision.get(file) ?? 0) < state.revision;

const reviewCloudflareShallowState = (file, state, processedRevision) => {
  const revision = state.revision;
  assertNoCloudflareStaticChunkLoadEffects(
    file,
    state.artifactRoot,
    [...state.invokedNames],
    new Map(),
    undefined,
    true,
    [...state.invokedReturns].map(parseCloudflareReturnedInvocationKey),
    [...state.invokedFunctionKeys]
  );
  processedRevision.set(file, revision);
};

const assertCloudflareShallowReviewCoverage = () => {
  const processedRevision = new Map();
  for (
    let cursor = 0;
    cursor < shallowScannedCloudflareOutputQueue.length;
    cursor += 1
  ) {
    const file = shallowScannedCloudflareOutputQueue[cursor];
    const state = shallowScannedCloudflareOutputFiles.get(file);
    if (!shouldReviewCloudflareShallowState(file, state, processedRevision))
      continue;
    reviewCloudflareShallowState(file, state, processedRevision);
  }
};

const decodeCanonicalBase64Url = (value, message) => {
  assert(typeof value === 'string', message);
  const decoded = Buffer.from(value, 'base64url');
  assert(decoded.toString('base64url') === value, message);
  return decoded;
};

const cloudflareAppChunkProvenanceKeyGuidance =
  'Cloudflare artifact verification requires a canonical 32-byte base64url build-time provenance key; run pnpm verify:artifact:cloudflare to build, sign, and verify atomically; advanced callers verifying the same signed build may pass cloudflareAppChunkProvenanceKey or START_UI_CLOUDFLARE_PROVENANCE_KEY';

const assertCloudflareAppChunkProvenanceKey = (value) => {
  const decoded = decodeCanonicalBase64Url(
    value,
    cloudflareAppChunkProvenanceKeyGuidance
  );
  assert(decoded.length === 32, cloudflareAppChunkProvenanceKeyGuidance);
};

const authenticatedCloudflareAppChunkPayload = (envelope, message) => {
  assert(
    isObjectRecord(envelope) &&
      envelope.version === 1 &&
      envelope.algorithm === 'hmac-sha256',
    message
  );
  const key = decodeCanonicalBase64Url(
    activeCloudflareAppChunkProvenanceKey,
    `${message}: missing verification key`
  );
  assert(key.length === 32, `${message}: invalid verification key`);
  const signature = decodeCanonicalBase64Url(envelope.signature, message);
  const expected = createHmac('sha256', key).update(envelope.payload).digest();
  assert(
    signature.length === expected.length &&
      timingSafeEqual(signature, expected),
    `${message}: signature mismatch`
  );
  return decodeCanonicalBase64Url(envelope.payload, message).toString('utf8');
};

const readCloudflareAppChunkProvenance = (manifestRecord) => {
  const realArtifactRoot = fs.realpathSync(manifestRecord.artifactRoot);
  const cached = cloudflareAppChunkProvenanceCache.get(realArtifactRoot);
  if (cached) return cached;
  const provenanceFile = path.resolve(
    manifestRecord.artifactRoot,
    cloudflareAppChunkProvenanceFile
  );
  assert(
    isWithinDirectory(provenanceFile, manifestRecord.artifactRoot),
    'Cloudflare app-owned provenance boundary'
  );
  assertFile(provenanceFile);
  assert(
    isWithinDirectory(fs.realpathSync(provenanceFile), realArtifactRoot),
    'Cloudflare app-owned provenance boundary'
  );
  const envelope = readVerifiedCloudflareMetadataJson(provenanceFile);
  const provenance = JSON.parse(
    authenticatedCloudflareAppChunkPayload(
      envelope,
      'Cloudflare app-owned provenance authentication'
    )
  );
  assert(
    isObjectRecord(provenance) &&
      provenance.version === 1 &&
      isObjectRecord(provenance.chunks),
    'Cloudflare app-owned provenance shape'
  );
  validateCloudflareAppChunkProvenance(
    provenance.chunks,
    manifestRecord,
    realArtifactRoot
  );
  cloudflareAppChunkProvenanceCache.set(realArtifactRoot, provenance.chunks);
  return provenance.chunks;
};

const isCloudflareAppModuleRecord = (module) =>
  isObjectRecord(module) &&
  module.owner === 'app' &&
  typeof module.id === 'string';

const isSafeCloudflareAppModuleId = (moduleId) =>
  moduleId.startsWith('src/') &&
  !moduleId.includes('\\') &&
  !moduleId.split('?')[0].split('/').includes('..');

const isCloudflareAppSourceModule = (module) =>
  isCloudflareAppModuleRecord(module) && isSafeCloudflareAppModuleId(module.id);

const isCloudflareNonAppSourceModule = (module) =>
  isObjectRecord(module) &&
  module.owner === 'non-app' &&
  typeof module.id === 'string' &&
  module.id.length > 0;

const assertCloudflareChunkModules = (record, message) => {
  assert(Array.isArray(record.modules), message);
  assert(
    record.modules.every(
      (module) =>
        isCloudflareAppSourceModule(module) ||
        isCloudflareNonAppSourceModule(module)
    ),
    message
  );
  const moduleIds = record.modules.map(({ id }) => id);
  assert(new Set(moduleIds).size === moduleIds.length, message);
};

const assertCloudflareChunkEdges = (record, message) => {
  for (const field of ['dynamicImports', 'imports']) {
    const edges = record[field];
    assert(isStringArray(edges), message);
    assert(new Set(edges).size === edges.length, message);
    assert(
      edges.every((edge) => isSafeRelativeArtifactFile(edge)),
      message
    );
  }
};

const assertCloudflareChunkDigest = (record, chunkFile, message) => {
  assert(
    typeof record.sha256 === 'string' && /^[\da-f]{64}$/u.test(record.sha256),
    message
  );
  const source = fs.readFileSync(chunkFile);
  const digest = createHash('sha256').update(source).digest('hex');
  assert(digest === record.sha256, message);
  authenticatedCloudflareModuleSources.set(path.resolve(chunkFile), {
    sha256: digest,
    source: source.toString('utf8'),
  });
};

const cloudflareProvenanceOwnership = (modules) => {
  const appModules = modules.filter(isCloudflareAppSourceModule).length;
  if (modules.length === 0 || appModules === 0) return 'non-app';
  return appModules === modules.length ? 'app-only' : 'mixed';
};

const assertCloudflareAppChunkRecord = (record, chunkFile) => {
  const message = `${chunkFile} must have trusted app-owned build provenance`;
  const cachedOwnership = validatedCloudflareAppChunkRecords.get(record);
  if (cachedOwnership) return cachedOwnership === 'app-only';
  assert(isObjectRecord(record), message);
  assert(
    new Set(['app-only', 'mixed', 'non-app']).has(record.ownership),
    message
  );
  assertCloudflareChunkModules(record, message);
  assertCloudflareChunkEdges(record, message);
  assertCloudflareChunkDigest(record, chunkFile, message);
  assert(
    record.ownership === cloudflareProvenanceOwnership(record.modules),
    message
  );
  validatedCloudflareAppChunkRecords.set(record, record.ownership);
  return record.ownership === 'app-only';
};

const cloudflareJavaScriptArtifactCoverage = (
  manifestRecord,
  realArtifactRoot
) => {
  const manifestEntries = viteManifestEntries(
    manifestRecord.manifest,
    manifestRecord.manifestFile
  );
  const manifestFiles = manifestEntries
    .map(({ file }) => file)
    .filter((file) => typeof file === 'string' && file.endsWith('.js'));
  assert(
    new Set(manifestFiles).size === manifestFiles.length,
    'Cloudflare app-owned manifest must map one record to each JavaScript output'
  );
  assertClosedCloudflareManifestGraph(
    manifestRecord.manifest,
    'Cloudflare app-owned manifest graph'
  );
  const artifactFiles = [
    ...new Set(
      findFilesNamedLike(realArtifactRoot, (name) => name.endsWith('.js')).map(
        (file) => normalizeArtifactFile(realArtifactRoot, file)
      )
    ),
  ];
  return { artifactFiles, manifestFiles };
};

const assertCloudflareManifestEdges = (entry, keys, message) => {
  for (const field of ['dynamicImports', 'imports']) {
    const edges = entry[field] ?? [];
    assert(isStringArray(edges), message);
    assert(new Set(edges).size === edges.length, message);
    assert(
      edges.every((key) => keys.has(key)),
      message
    );
  }
};

const assertClosedCloudflareManifestGraph = (manifest, message) => {
  const keys = new Set(Object.keys(manifest));
  Object.values(manifest).forEach((entry) =>
    assertCloudflareManifestEdges(entry, keys, message)
  );
};

const assertAuthenticatedCloudflareSourcesUnchanged = () => {
  for (const [file, authenticated] of authenticatedCloudflareModuleSources) {
    const metadata = fs.lstatSync(file);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      'Cloudflare authenticated source changed during verification'
    );
    const digest = createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    assert(
      digest === authenticated.sha256,
      'Cloudflare authenticated source changed during verification'
    );
  }
};

const assertVerifiedCloudflareMetadataUnchanged = () => {
  for (const [file, verified] of verifiedCloudflareMetadataSources) {
    const metadata = fs.lstatSync(file);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      'Cloudflare verifier metadata changed during verification'
    );
    const digest = createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    assert(
      digest === verified.sha256,
      'Cloudflare verifier metadata changed during verification'
    );
  }
};

const assertExactCloudflareDiskManifestCoverage = (
  manifestFiles,
  artifactFiles,
  message
) => {
  const manifestFileSet = new Set(manifestFiles);
  const artifactFileSet = new Set(artifactFiles);
  const unmanifestedFiles = artifactFiles.filter(
    (file) => !manifestFileSet.has(file)
  );
  const missingArtifactFiles = manifestFiles.filter(
    (file) => !artifactFileSet.has(file)
  );
  assert(
    exactSortedValues(manifestFiles, artifactFiles),
    `${message}: unmanifested ${unmanifestedFiles.join(', ') || 'none'}; missing output ${
      missingArtifactFiles.join(', ') || 'none'
    }`
  );
};

const assertExactCloudflareProvenanceCoverage = (
  chunks,
  expectedFiles,
  message
) => {
  const recordedFiles = Object.keys(chunks);
  const expectedFileSet = new Set(expectedFiles);
  const recordedFileSet = new Set(recordedFiles);
  const missingFiles = expectedFiles.filter(
    (file) => !recordedFileSet.has(file)
  );
  const extraFiles = recordedFiles.filter((file) => !expectedFileSet.has(file));
  assert(
    exactSortedValues(recordedFiles, expectedFiles),
    `${message}: missing ${missingFiles.join(', ') || 'none'}; extra ${
      extraFiles.join(', ') || 'none'
    }`
  );
};

const assertCloudflareProvenanceChunk = (
  chunks,
  file,
  artifactRoot,
  realArtifactRoot,
  message
) => {
  const chunkFile = path.resolve(artifactRoot, file);
  assert(isWithinDirectory(chunkFile, artifactRoot), message);
  assertFile(chunkFile);
  assert(
    isWithinDirectory(fs.realpathSync(chunkFile), realArtifactRoot),
    message
  );
  assertCloudflareAppChunkRecord(chunks[file], chunkFile);
  const authenticated = authenticatedCloudflareModuleSources.get(
    path.resolve(chunkFile)
  );
  assert(authenticated, message);
  authenticatedCloudflareModuleSources.set(
    path.resolve(realArtifactRoot, file),
    authenticated
  );
};

const validateCloudflareAppChunkProvenance = (
  chunks,
  manifestRecord,
  realArtifactRoot
) => {
  const message = 'Cloudflare app-owned provenance coverage';
  const coverage = cloudflareJavaScriptArtifactCoverage(
    manifestRecord,
    realArtifactRoot
  );
  assertExactCloudflareDiskManifestCoverage(
    coverage.manifestFiles,
    coverage.artifactFiles,
    message
  );
  assertExactCloudflareProvenanceCoverage(
    chunks,
    coverage.manifestFiles,
    message
  );
  coverage.manifestFiles.forEach((file) =>
    assertCloudflareProvenanceChunk(
      chunks,
      file,
      manifestRecord.artifactRoot,
      realArtifactRoot,
      message
    )
  );
};

const cloudflareManifestChunkRecord = (key, manifestRecord) => {
  const message = 'Cloudflare app-owned manifest provenance';
  assert(isObjectRecord(manifestRecord), message);
  const entry = manifestRecord.manifest[key];
  assert(isObjectRecord(entry) && typeof entry.file === 'string', message);
  const chunkFile = path.resolve(manifestRecord.artifactRoot, entry.file);
  const realArtifactRoot = fs.realpathSync(manifestRecord.artifactRoot);
  assert(isWithinDirectory(chunkFile, manifestRecord.artifactRoot), message);
  assertFile(chunkFile);
  assert(
    isWithinDirectory(fs.realpathSync(chunkFile), realArtifactRoot),
    message
  );
  const chunks = readCloudflareAppChunkProvenance(manifestRecord);
  const record = chunks[entry.file];
  assertCloudflareAppChunkRecord(record, chunkFile);
  for (const field of ['dynamicImports', 'imports']) {
    const manifestEdges = manifestFilesForKeys(
      manifestRecord,
      entry[field] ?? [],
      message
    );
    assert(exactSortedValues(record[field], manifestEdges), message);
  }
  return record;
};
const isAppOwnedCloudflareManifestKey = (key, manifestRecord) =>
  cloudflareManifestChunkRecord(key, manifestRecord).ownership === 'app-only';
const cloudflareClosureNodeId = (manifestRecord, key, message) =>
  manifestRecordNodeIdentity(manifestRecord, key, message);

const cloudflareManifestFileKeyIndexCache = new WeakMap();

const cloudflareManifestFileKeyIndex = (manifest) => {
  const cached = cloudflareManifestFileKeyIndexCache.get(manifest);
  if (cached) return cached;
  const index = new Map();
  Object.entries(manifest).forEach(([key, entry]) => {
    if (!isObjectRecord(entry) || typeof entry.file !== 'string') return;
    const keys = index.get(entry.file) ?? [];
    keys.push(key);
    index.set(entry.file, keys);
  });
  cloudflareManifestFileKeyIndexCache.set(manifest, index);
  return index;
};

const readCloudflareClosureNode = (key, manifestRecord, realRoot, message) => {
  const entry = manifestRecord.manifest[key];
  assert(isObjectRecord(entry), message);
  const { file } = entry;
  const imports = entry.imports ?? [];
  assert(typeof file === 'string', message);
  assert(isStringArray(imports), message);
  const chunkFile = path.resolve(manifestRecord.artifactRoot, file);
  assert(isWithinDirectory(chunkFile, manifestRecord.artifactRoot), message);
  assertFile(chunkFile);
  assert(isWithinDirectory(fs.realpathSync(chunkFile), realRoot), message);
  const matchingKeys =
    cloudflareManifestFileKeyIndex(manifestRecord.manifest).get(file) ?? [];
  assert(matchingKeys.length === 1, message);
  assert(matchingKeys[0] === key, message);
  return {
    chunkFile,
    entry,
    file,
    imports,
    program: readParsedModule(chunkFile).program,
  };
};

const cloudflareClosureSourceGraph = (
  program,
  chunkFile,
  imports,
  manifestRecord,
  realRoot,
  message
) => {
  const expectedFiles = manifestFilesForKeys(manifestRecord, imports, message);
  assert(
    new Set(imports).size === imports.length &&
      new Set(expectedFiles).size === expectedFiles.length,
    message
  );
  const expectedTargets = new Map(
    imports.map((importKey, index) => [
      expectedFiles[index],
      cloudflareClosureNodeId(manifestRecord, importKey, message),
    ])
  );
  const staticSourceTargets = new Map();
  const relativeFiles = [];
  const edges = cloudflareStaticDependencySources(program).map((source) => {
    if (!source.startsWith('.')) {
      assert(reviewedCloudflareClosureExternals.has(source), message);
      staticSourceTargets.set(source, `external:${source}`);
      return { kind: 'external', target: source };
    }
    const { artifactFile } = cloudflareRelativeArtifactLink(
      chunkFile,
      source,
      manifestRecord,
      realRoot,
      message
    );
    const target = expectedTargets.get(artifactFile);
    assert(typeof target === 'string', message);
    relativeFiles.push(artifactFile);
    staticSourceTargets.set(source, `internal:${target}`);
    return { kind: 'internal', target };
  });
  assert(exactSortedValues(relativeFiles, expectedFiles), message);
  return { edges, staticSourceTargets };
};

const cloudflareClosureDynamicSourceGraph = (
  program,
  chunkFile,
  entry,
  manifestRecord,
  realRoot,
  message
) => {
  const dynamicKeys = entry.dynamicImports ?? [];
  assert(isStringArray(dynamicKeys), message);
  const expectedFiles = manifestFilesForKeys(
    manifestRecord,
    dynamicKeys,
    message
  );
  const expectedTargets = new Map(
    dynamicKeys.map((key, index) => [
      expectedFiles[index],
      cloudflareClosureNodeId(manifestRecord, key, message),
    ])
  );
  const dynamicSourceTargets = new Map();
  const actualFiles = [];
  const edges = cloudflareDynamicImportSources(program).map((source) => {
    if (source === undefined) {
      return { kind: 'runtime', target: 'nonliteral' };
    }
    if (!source?.startsWith('.')) {
      assert(reviewedCloudflareClosureExternals.has(source), message);
      dynamicSourceTargets.set(source, `external:${source}`);
      return { kind: 'external', target: source };
    }
    const { artifactFile } = cloudflareRelativeArtifactLink(
      chunkFile,
      source,
      manifestRecord,
      realRoot,
      message
    );
    const target = expectedTargets.get(artifactFile);
    assert(typeof target === 'string', message);
    actualFiles.push(artifactFile);
    dynamicSourceTargets.set(source, `dynamic:${target}`);
    return { kind: 'dynamic', target };
  });
  assert(exactSortedValues([...new Set(actualFiles)], expectedFiles), message);
  return { dynamicKeys, dynamicSourceTargets, edges };
};

const cloudflareClosureProgramDigest = (
  program,
  staticSourceTargets,
  dynamicSourceTargets,
  message
) =>
  astDigest(program, (source, kind) => {
    const target =
      kind === 'static'
        ? staticSourceTargets.get(source)
        : dynamicSourceTargets.get(source);
    assert(typeof target === 'string', message);
    return target;
  });

const normalizedTanStackManifestAsset = (value) =>
  value.replace(
    /^(\/assets\/.+)-[-_A-Za-z0-9]{8}(\.(?:css|js))$/u,
    '$1-[content-hash]$2'
  );

const normalizedTanStackManifestRouteFile = (value) => {
  const match = /[/\\]src[/\\]routes[/\\](.+)$/u.exec(value);
  return match ? `src/routes/${match[1].replaceAll('\\', '/')}` : value;
};

const normalizeTanStackManifestAssetLiteral = (node) => {
  if (typeof node?.value !== 'string') return;
  node.value = normalizedTanStackManifestAsset(node.value);
};

const normalizeTanStackManifestAssetArray = (property) => {
  if (!new Set(['css', 'preloads']).has(propertyKeyName(property))) return;
  if (nodeType(property.value) !== 'ArrayExpression') return;
  property.value.elements.forEach(normalizeTanStackManifestAssetLiteral);
};

const tanStackManifestPropertyValue = (object, name) =>
  object.properties.find((candidate) => propertyKeyName(candidate) === name)
    ?.value;

const tanStackManifestAttributeSource = (attrs) => {
  if (nodeType(attrs) !== 'ObjectExpression') return undefined;
  return tanStackManifestPropertyValue(attrs, 'src');
};

const tanStackManifestScriptSource = (script) => {
  if (nodeType(script) !== 'ObjectExpression') return undefined;
  const attrs = script.properties.find(
    (candidate) => propertyKeyName(candidate) === 'attrs'
  )?.value;
  return tanStackManifestAttributeSource(attrs);
};

const normalizeTanStackManifestScriptAsset = (script) => {
  normalizeTanStackManifestAssetLiteral(tanStackManifestScriptSource(script));
};

const normalizeTanStackManifestScriptAssets = (property) => {
  if (propertyKeyName(property) !== 'scripts') return;
  if (nodeType(property.value) !== 'ArrayExpression') return;
  property.value.elements.forEach(normalizeTanStackManifestScriptAsset);
};

const normalizeTanStackManifestPreloadOrder = (property) => {
  if (propertyKeyName(property) !== 'preloads') return;
  if (nodeType(property.value) !== 'ArrayExpression') return;
  const preloads = property.value.elements;
  if (!preloads.every((preload) => literalString(preload) !== undefined)) {
    return;
  }
  property.value.elements = preloads.toSorted((left, right) =>
    compareCodePointStrings(literalString(left), literalString(right))
  );
};

const normalizeTanStackManifestProperty = (property) => {
  normalizeTanStackManifestAssetArray(property);
  normalizeTanStackManifestScriptAssets(property);
  normalizeTanStackManifestPreloadOrder(property);
  if (propertyKeyName(property) !== 'filePath') return;
  if (typeof property.value?.value !== 'string') return;
  property.value.value = normalizedTanStackManifestRouteFile(
    property.value.value
  );
};

const tanStackManifestProgramDigest = (program) => {
  const normalized = structuredClone(program);
  new Visitor({
    Property: normalizeTanStackManifestProperty,
  }).visit(normalized);
  return astDigest(normalized);
};

const cloudflareClosureNodeProgramDigest = (
  program,
  entry,
  staticSourceTargets,
  dynamicSourceTargets,
  message
) =>
  entry.src === 'tanstack-start-manifest:v'
    ? tanStackManifestProgramDigest(program)
    : cloudflareClosureProgramDigest(
        program,
        staticSourceTargets,
        dynamicSourceTargets,
        message
      );

const cloudflareClosureDynamicKeysToVisit = (
  key,
  rootKey,
  allowRootDynamicImports,
  dynamicKeys,
  manifestRecord
) => {
  if (key === rootKey && allowRootDynamicImports) return [];
  return dynamicKeys.filter(
    (dynamicKey) => !isAppOwnedCloudflareManifestKey(dynamicKey, manifestRecord)
  );
};

const cloudflareClosureStaticKeysToVisit = (staticKeys, manifestRecord) =>
  staticKeys.filter(
    (staticKey) => !isAppOwnedCloudflareManifestKey(staticKey, manifestRecord)
  );

const readCloudflareClosureDigestNode = (
  key,
  manifestRecord,
  realArtifactRoot,
  message,
  allowRootDynamicImports,
  loadEffectVisited
) => {
  const nodeMessage = `${message} at ${String(key)}`;
  const { chunkFile, entry, imports, program } = readCloudflareClosureNode(
    key,
    manifestRecord,
    realArtifactRoot,
    nodeMessage
  );
  const { edges, staticSourceTargets } = cloudflareClosureSourceGraph(
    program,
    chunkFile,
    imports,
    manifestRecord,
    realArtifactRoot,
    nodeMessage
  );
  const dynamicGraph = cloudflareClosureDynamicSourceGraph(
    program,
    chunkFile,
    entry,
    manifestRecord,
    realArtifactRoot,
    nodeMessage
  );
  assertNoCloudflareStaticChunkLoadEffects(
    chunkFile,
    manifestRecord.artifactRoot,
    [],
    loadEffectVisited
  );
  return {
    nextKeys: [
      ...cloudflareClosureStaticKeysToVisit(imports, manifestRecord),
      ...cloudflareClosureDynamicKeysToVisit(
        key,
        manifestRecord.key,
        allowRootDynamicImports,
        dynamicGraph.dynamicKeys,
        manifestRecord
      ),
    ],
    node: {
      astDigest: cloudflareClosureNodeProgramDigest(
        program,
        entry,
        staticSourceTargets,
        dynamicGraph.dynamicSourceTargets,
        nodeMessage
      ),
      edges: [...edges, ...dynamicGraph.edges],
      id: cloudflareClosureNodeId(manifestRecord, key, nodeMessage),
    },
  };
};

const cloudflareBoundedModuleGraph = (rootKey, visit) => {
  const moduleLimit = cloudflareLoadEffectCoordinatorLimits.modules;
  const pendingKeys = [rootKey];
  const queuedKeys = new Set(pendingKeys);
  const visitedKeys = new Set();
  while (pendingKeys.length > 0) {
    const key = pendingKeys.pop();
    queuedKeys.delete(key);
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);
    assert(
      visitedKeys.size + queuedKeys.size <= moduleLimit,
      `Cloudflare artifact analysis exceeded bounded module work (${visitedKeys.size} visited, ${queuedKeys.size} queued)`
    );
    visit(key).forEach((nextKey) => {
      if (visitedKeys.has(nextKey) || queuedKeys.has(nextKey)) return;
      assert(
        visitedKeys.size + queuedKeys.size < moduleLimit,
        `Cloudflare artifact analysis exceeded bounded module work (${visitedKeys.size} visited, ${queuedKeys.size} queued)`
      );
      queuedKeys.add(nextKey);
      pendingKeys.push(nextKey);
    });
  }
  return visitedKeys;
};

export const inspectCloudflareModuleGraphBoundForTesting = (degree) =>
  cloudflareBoundedModuleGraph('root', (key) =>
    key === 'root'
      ? Array.from({ length: degree }, (_unused, index) => `module-${index}`)
      : []
  ).size;

const cloudflareStaticImportClosureDigest = (
  rootChunk,
  manifestRecord,
  message,
  allowRootDynamicImports = false
) => {
  assert(
    manifestRecord.entry.file ===
      normalizeArtifactFile(manifestRecord.artifactRoot, rootChunk),
    message
  );
  const nodes = [];
  const loadEffectVisited = new Map();
  const realArtifactRoot = fs.realpathSync(manifestRecord.artifactRoot);
  const visitedKeys = cloudflareBoundedModuleGraph(
    manifestRecord.key,
    (key) => {
      const { nextKeys, node } = readCloudflareClosureDigestNode(
        key,
        manifestRecord,
        realArtifactRoot,
        message,
        allowRootDynamicImports,
        loadEffectVisited
      );
      nodes.push(node);
      return nextKeys;
    }
  );
  const orderedNodes = nodes.toSorted((left, right) =>
    compareCodePointStrings(left.id, right.id)
  );
  assert(
    new Set(orderedNodes.map(({ id }) => id)).size === orderedNodes.length,
    message
  );
  const reviewRecord = {
    nodes: orderedNodes,
    root: cloudflareClosureNodeId(manifestRecord, manifestRecord.key, message),
    version: 2,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(reviewRecord))
    .digest('hex');
  recordReviewedCloudflareManifestKeys(visitedKeys, manifestRecord);
  return digest;
};

const isTanStackEmptyPluginAdaptersSource = (source) =>
  typeof source === 'string' &&
  source.endsWith(
    '/node_modules/@tanstack/start-server-core/dist/esm/empty-plugin-adapters.js'
  );

const readTanStackDynamicOwnerRecord = (key, manifestRecord, message) => {
  const entry = manifestRecord.manifest[key];
  assert(isObjectRecord(entry), message);
  assert(entry.isDynamicEntry === true, message);
  assert(entry.src === key, message);
  const chunkFile = path.resolve(manifestRecord.artifactRoot, entry.file);
  const record = assertCloudflareChunkManifestMembership(
    manifestRecord.artifactRoot,
    chunkFile,
    'TanStack dynamic owner'
  );
  assert(record.key === key, message);
  return { chunkFile, entry, key };
};

const readTanStackDynamicOwnerRecords = (
  dynamicKeys,
  manifestRecord,
  message
) => {
  const records = [];
  for (const key of dynamicKeys) {
    records.push(readTanStackDynamicOwnerRecord(key, manifestRecord, message));
  }
  return records;
};

const assertReviewedRouterOwner = (routerRecord, trustedOwnerDigests) => {
  const routerProgram = readParsedModule(routerRecord.chunkFile).program;
  const getRouterExports = routerProgram.body
    .flatMap(namedExportEntries)
    .filter(
      ([exportedName, localName]) =>
        exportedName === 'getRouter' && localName === 'getRouter'
    );
  const message = `${routerRecord.chunkFile} must use the reviewed getRouter artifact owner closure`;
  assert(getRouterExports.length === 1, message);
  const manifestRecord = assertCloudflareChunkManifestMembership(
    path.dirname(path.dirname(routerRecord.chunkFile)),
    routerRecord.chunkFile,
    'getRouter owner'
  );
  const routerDigest = artifactOwnerClosureDigest(
    { ...manifestRecord, chunkFile: routerRecord.chunkFile },
    'getRouter',
    message
  );
  assert(
    routerDigest === astField(trustedOwnerDigests, 'routerLocalClosure'),
    `${message} (${routerDigest})`
  );
};

const assertReviewedStartOwner = (startRecord, trustedOwnerDigests) => {
  const program = readParsedModule(startRecord.chunkFile).program;
  const message = `${startRecord.chunkFile} must use the reviewed startInstance artifact owner closure`;
  const exports = program.body
    .flatMap(namedExportEntries)
    .filter(
      ([exportedName, localName]) =>
        exportedName === 'startInstance' && localName === 'startInstance'
    );
  assert(exports.length === 1, message);
  const manifestRecord = assertCloudflareChunkManifestMembership(
    path.dirname(path.dirname(startRecord.chunkFile)),
    startRecord.chunkFile,
    'startInstance owner'
  );
  const digest = artifactOwnerClosureDigest(
    { ...manifestRecord, chunkFile: startRecord.chunkFile },
    'startInstance',
    message
  );
  assert(
    digest === astField(trustedOwnerDigests, 'startOwnerClosure'),
    `${message} (${digest})`
  );
};

const manifestArrayValueIsData = (node) =>
  node.elements.every(
    (element) => element !== null && manifestRouteValueIsData(element)
  );

const manifestObjectPropertyIsData = (property) =>
  [
    property.type === 'Property',
    property.kind === 'init',
    property.method === false,
    property.computed === false,
    manifestRouteValueIsData(property.value),
  ].every(Boolean);

const manifestObjectValueIsData = (node) =>
  node.properties.every(manifestObjectPropertyIsData);

const inertManifestUnaryOperators = new Set(['!', 'void']);

const manifestUnaryValueIsData = (node) =>
  inertManifestUnaryOperators.has(node.operator) &&
  manifestRouteValueIsData(node.argument);

const manifestRouteDataReaders = {
  ArrayExpression: manifestArrayValueIsData,
  Literal: () => true,
  ObjectExpression: manifestObjectValueIsData,
  UnaryExpression: manifestUnaryValueIsData,
};

const manifestRouteValueIsData = (node) => {
  const readData = manifestRouteDataReaders[nodeType(node)];
  return readData ? readData(node) : false;
};

const tanStackManifestRouteFields = new Set([
  'children',
  'css',
  'filePath',
  'preloads',
  'scripts',
]);

const tanStackManifestRoutes = (owner, message) => {
  const ownerBody = unwrapCloudflareExecutionTarget(owner.body);
  assert(nodeType(owner) === 'ArrowFunctionExpression', message);
  assert(owner.params.length === 0, message);
  assert(nodeType(ownerBody) === 'ObjectExpression', message);
  const rootProperties = ownerBody.properties;
  assert(rootProperties.length === 1, message);
  assert(propertyKeyName(rootProperties[0]) === 'routes', message);
  assert(nodeType(rootProperties[0].value) === 'ObjectExpression', message);
  return rootProperties[0].value.properties;
};

const assertTanStackManifestRouteField = (field, message) => {
  assert(field.type === 'Property', message);
  assert(tanStackManifestRouteFields.has(propertyKeyName(field)), message);
  assert(manifestRouteValueIsData(field.value), message);
};

const assertTanStackManifestRouteFile = (
  filePath,
  sourceRoutesRoot,
  message
) => {
  assert(path.isAbsolute(filePath), message);
  const resolvedFile = path.resolve(filePath);
  assert(isWithinDirectory(resolvedFile, sourceRoutesRoot), message);
  assertDirectory(sourceRoutesRoot);
  assertFile(resolvedFile);
  assert(
    isWithinDirectory(
      fs.realpathSync(resolvedFile),
      fs.realpathSync(sourceRoutesRoot)
    ),
    message
  );
};

const assertTanStackManifestRoute = (route, sourceRoutesRoot, message) => {
  assert(route.type === 'Property', message);
  assert(typeof propertyKeyName(route) === 'string', message);
  assert(nodeType(route.value) === 'ObjectExpression', message);
  const fields = route.value.properties;
  const fieldNames = fields.map(propertyKeyName);
  assert(fieldNames.length === new Set(fieldNames).size, message);
  fields.forEach((field) => assertTanStackManifestRouteField(field, message));
  const filePath = fields.find(
    (field) => propertyKeyName(field) === 'filePath'
  )?.value;
  const routeFile = literalString(filePath);
  assert(typeof routeFile === 'string', message);
  assertTanStackManifestRouteFile(routeFile, sourceRoutesRoot, message);
};

const assertInertTanStackManifestOwner = (owner, message) => {
  const functions = cloudflareFunctionNodes(owner);
  let executable = false;
  new Visitor({
    CallExpression() {
      executable = true;
    },
    ImportExpression() {
      executable = true;
    },
    NewExpression() {
      executable = true;
    },
  }).visit(owner);
  assert(functions.length === 1 && functions[0] === owner, message);
  assert(!executable, message);
};

const assertReviewedManifestOwner = (manifestRecord) => {
  const program = readParsedModule(manifestRecord.chunkFile).program;
  const message = `${manifestRecord.chunkFile} must use the reviewed TanStack route manifest shape`;
  const exports = program.body
    .flatMap(namedExportEntries)
    .filter(
      ([exportedName, localName]) =>
        exportedName === 'tsrStartManifest' && localName === 'tsrStartManifest'
    );
  const owners = topLevelBindingDeclarators(program, 'tsrStartManifest');
  assert(program.body.length === 2, message);
  assert(exports.length === 1, message);
  assert(owners.length === 1, message);
  const owner = owners[0].init;
  const artifactRoot =
    manifestRecord.artifactRoot ??
    path.dirname(path.dirname(manifestRecord.chunkFile));
  const sourceRoutesRoot = path.resolve(artifactRoot, '../..', 'src/routes');
  tanStackManifestRoutes(owner, message).forEach((route) =>
    assertTanStackManifestRoute(route, sourceRoutesRoot, message)
  );
  assertInertTanStackManifestOwner(owner, message);
};

const assertReviewedEmptyPluginOwner = (
  emptyPluginRecord,
  trustedOwnerDigests,
  message
) => {
  const emptyPluginProgram = readParsedModule(
    emptyPluginRecord.chunkFile
  ).program;
  assert(
    (emptyPluginRecord.entry.imports ?? []).length === 0 &&
      (emptyPluginRecord.entry.dynamicImports ?? []).length === 0,
    message
  );
  const digest = astDigest(emptyPluginProgram);
  assert(
    digest === astField(trustedOwnerDigests, 'emptyPluginAdaptersChunk'),
    `${emptyPluginRecord.chunkFile} must use the reviewed empty plugin adapters owner (${digest})`
  );
  reviewedCloudflareOutputFiles.add(
    fs.realpathSync(emptyPluginRecord.chunkFile)
  );
};

const tanStackDynamicOwnerKinds = (records) => ({
  emptyPluginRecords: records.filter(({ key }) =>
    isTanStackEmptyPluginAdaptersSource(key)
  ),
  manifestOwner: records.find(({ key }) => key === 'tanstack-start-manifest:v'),
  routerRecord: records.find(({ key }) => key === 'src/router.tsx'),
  startRecord: records.find(({ key }) => key === 'src/start.ts'),
});

const assertReviewedDynamicOwnerGraph = (
  record,
  loadEffectVisited,
  dependencyVisited
) => {
  const artifactRoot = path.dirname(path.dirname(record.chunkFile));
  assertExactCloudflareDependencyGraph(
    record.chunkFile,
    artifactRoot,
    loadEffectVisited,
    dependencyVisited
  );
};

const tanStackDynamicSourceFiles = (
  helperProgram,
  helperChunk,
  dynamicKeys,
  manifestRecord,
  message
) => {
  const sources = cloudflareDynamicImportSources(helperProgram);
  assert(Array.isArray(dynamicKeys), message);
  assert(new Set(dynamicKeys).size === dynamicKeys.length, message);
  assert(sources.length === dynamicKeys.length, message);
  assert(
    sources.every((source) => source?.startsWith('./')),
    message
  );
  return sources.map((source) => {
    const linkedFile = path.resolve(path.dirname(helperChunk), source);
    assert(isWithinDirectory(linkedFile, manifestRecord.artifactRoot), message);
    assertFile(linkedFile);
    assert(
      isWithinDirectory(
        fs.realpathSync(linkedFile),
        fs.realpathSync(manifestRecord.artifactRoot)
      ),
      message
    );
    return normalizeArtifactFile(manifestRecord.artifactRoot, linkedFile);
  });
};

const assertReviewedTanStackDynamicOwners = (
  helperProgram,
  helperChunk,
  manifestRecord,
  trustedOwnerDigests
) => {
  const message = `${helperChunk} must preserve its reviewed TanStack dynamic owner graph`;
  const dynamicKeys = manifestRecord.entry.dynamicImports;
  assert(Array.isArray(dynamicKeys), message);
  const expectedFiles = manifestFilesForKeys(
    manifestRecord,
    dynamicKeys,
    message
  );
  const actualFiles = tanStackDynamicSourceFiles(
    helperProgram,
    helperChunk,
    dynamicKeys,
    manifestRecord,
    message
  );
  assert(exactSortedValues(actualFiles, expectedFiles), message);
  const records = readTanStackDynamicOwnerRecords(
    dynamicKeys,
    manifestRecord,
    message
  );
  const { emptyPluginRecords, manifestOwner, routerRecord, startRecord } =
    tanStackDynamicOwnerKinds(records);
  assert(records.length === 4, message);
  assert(routerRecord, message);
  assert(startRecord, message);
  assert(manifestOwner, message);
  assert(emptyPluginRecords.length === 1, message);
  const loadEffectVisited = new Map();
  const dependencyVisited = new Set();
  assertReviewedDynamicOwnerGraph(
    routerRecord,
    loadEffectVisited,
    dependencyVisited
  );
  assertReviewedDynamicOwnerGraph(
    startRecord,
    loadEffectVisited,
    dependencyVisited
  );
  assertReviewedDynamicOwnerGraph(
    manifestOwner,
    loadEffectVisited,
    dependencyVisited
  );
  assertReviewedRouterOwner(routerRecord, trustedOwnerDigests);
  assertReviewedStartOwner(startRecord, trustedOwnerDigests);
  assertReviewedManifestOwner(manifestOwner);
  assertReviewedEmptyPluginOwner(
    emptyPluginRecords[0],
    trustedOwnerDigests,
    message
  );
};

const assertCloudflareTanStackOwnerDigest = (
  helperProgram,
  helperChunk,
  ownerName,
  expectedDigest
) => {
  const owners = helperProgram.body
    .flatMap(topLevelFunctionEntries)
    .filter(([name]) => name === ownerName);
  assert(
    owners.length === 1 && typeof expectedDigest === 'string',
    `${helperChunk} must use the reviewed ${ownerName} implementation`
  );
  assert(
    astDigest(owners[0][1]) === expectedDigest,
    `${helperChunk} must use the reviewed ${ownerName} implementation`
  );
};

const isExactObservedStreamHandler = (handler) => {
  if (nodeType(handler) !== 'ArrowFunctionExpression') return false;
  if (nodeType(handler.body) !== 'BlockStatement') return false;
  const calls = directFunctionCalls(handler, nestedFunctionRanges(handler));
  return [
    handler.async,
    handler.params.length === 1,
    bindingNames(handler.params[0]).join(':') ===
      'request:responseHeaders:router',
    handler.body.body.length === 7,
    exactSortedValues([...calls], exactObservedStreamCalls),
    isExactObservedStreamDataflow(handler),
    identifierOccurrenceCount(handler, 'renderToReadableStream') === 1,
    identifierOccurrenceCount(handler, 'createElement') === 1,
    identifierOccurrenceCount(handler, 'StartServer') === 1,
    identifierOccurrenceCount(handler, 'fetch') === 0,
  ].every(Boolean);
};

const isExactObservedStreamInitializer = (node) => {
  if (nodeType(node) !== 'CallExpression') return false;
  const [handler] = node.arguments;
  return [
    identifierName(node.callee) === 'defineHandlerCallback',
    node.arguments.length === 1,
    isExactObservedStreamHandler(handler),
  ].every(Boolean);
};

const isExactCreateServerEntryInitializer = (node) => {
  if (nodeType(node) !== 'ArrowFunctionExpression') return false;
  const [serverEntry] = node.params;
  return [
    node.async === false,
    node.expression === true,
    node.params.length === 1,
    identifierName(serverEntry) === 'serverEntry',
    identifierName(node.body) === 'serverEntry',
  ].every(Boolean);
};

const isExactTanStackEntryFetchCall = (node) => {
  if (nodeType(node) !== 'CallExpression') return false;
  return [
    identifierName(node.callee) === 'createStartHandler',
    node.arguments.length === 1,
    identifierName(node.arguments[0]) === 'observedStreamHandler',
  ].every(Boolean);
};

const isExactTanStackEntryFetchProperty = (property) => {
  if (nodeType(property) !== 'Property') return false;
  return [
    property.computed === false,
    property.kind === 'init',
    property.method === false,
    propertyKeyName(property) === 'fetch',
    isExactTanStackEntryFetchCall(property.value),
  ].every(Boolean);
};

const isExactTanStackEntryInitializer = (node) => {
  if (nodeType(node) !== 'ObjectExpression') return false;
  return [
    node.properties.length === 1,
    isExactTanStackEntryFetchProperty(node.properties[0]),
  ].every(Boolean);
};

const tanStackEntryInitializerReaders = {
  createServerEntry: isExactCreateServerEntryInitializer,
  entry: isExactTanStackEntryInitializer,
  import_react: (node) => isExactEntryInteropInitializer(node, 'require_react'),
  import_server_edge: (node) =>
    isExactEntryInteropInitializer(node, 'require_server_edge'),
  isAbortError: (node) => nodeType(node) === 'ArrowFunctionExpression',
  noop: (node) => nodeType(node) === 'ArrowFunctionExpression',
  observedStreamHandler: isExactObservedStreamInitializer,
  waitForReadyOrAbort: (node) => nodeType(node) === 'ArrowFunctionExpression',
};

const assertReviewedObservedStreamHandler = (
  declarations,
  chunkFile,
  trustedOwnerDigests
) => {
  const declaration = declarations.find(
    (candidate) => identifierName(candidate.id) === 'observedStreamHandler'
  );
  const handler = astItem(declaration?.init, 'arguments', 0);
  const digest = astDigest(handler);
  assert(
    digest === astField(trustedOwnerDigests, 'observedStreamHandler'),
    `${chunkFile} must use the reviewed observed stream handler (${digest})`
  );
};

const assertReviewedTanStackServerOwners = (
  program,
  chunkFile,
  trustedOwnerDigests
) => {
  const sourcePattern = /^\.\/server(?:-[\w-]+)?\.js$/;
  const startHandlerOwner = assertExactStaticChunkHelper(
    program,
    chunkFile,
    'createStartHandler',
    sourcePattern
  );
  const handlerCallbackOwner = assertExactStaticChunkHelper(
    program,
    chunkFile,
    'defineHandlerCallback',
    sourcePattern
  );
  assertCloudflareTanStackOwnerDigest(
    startHandlerOwner.helperProgram,
    startHandlerOwner.helperChunk,
    'createStartHandler',
    astField(trustedOwnerDigests, 'createStartHandler')
  );
  assertCloudflareTanStackOwnerDigest(
    handlerCallbackOwner.helperProgram,
    handlerCallbackOwner.helperChunk,
    'defineHandlerCallback',
    astField(trustedOwnerDigests, 'defineHandlerCallback')
  );
  const serverImplementationMessage = `${chunkFile} must use the reviewed TanStack server implementation closure`;
  assert(
    startHandlerOwner.helperChunk === handlerCallbackOwner.helperChunk,
    serverImplementationMessage
  );
  assertReviewedTanStackDynamicOwners(
    startHandlerOwner.helperProgram,
    startHandlerOwner.helperChunk,
    startHandlerOwner.manifestRecord,
    trustedOwnerDigests
  );
  const serverClosureMessage = `${chunkFile} must use the reviewed TanStack server static import closure`;
  const serverClosureDigest = cloudflareStaticImportClosureDigest(
    startHandlerOwner.helperChunk,
    startHandlerOwner.manifestRecord,
    serverClosureMessage,
    true
  );
  assert(
    serverClosureDigest === astField(trustedOwnerDigests, 'serverClosure'),
    `${serverClosureMessage} (${serverClosureDigest})`
  );
  const edgeImports = staticImportsForBinding(program, 'require_server_edge');
  assertConditions(
    [
      edgeImports.length === 1,
      /^\.\/server\.edge(?:-[\w-]+)?\.js$/.test(
        astField(edgeImports[0], 'source')
      ),
    ],
    `${chunkFile} must import the reviewed React server renderer`
  );
  const edgeChunk = path.resolve(
    path.dirname(chunkFile),
    astField(edgeImports[0], 'source')
  );
  assertFile(edgeChunk);
  const edgeManifestRecord = assertCloudflareChunkManifestMembership(
    path.dirname(path.dirname(chunkFile)),
    edgeChunk,
    'React server renderer'
  );
  const edgeClosureMessage = `${chunkFile} must use the reviewed React server renderer static import closure`;
  const edgeClosureDigest = cloudflareStaticImportClosureDigest(
    edgeChunk,
    edgeManifestRecord,
    edgeClosureMessage
  );
  assert(
    edgeClosureDigest === astField(trustedOwnerDigests, 'serverEdgeClosure'),
    `${edgeClosureMessage} (${edgeClosureDigest})`
  );
};

const assertCloudflareTanStackEntryChunk = (
  program,
  chunkFile,
  manifestRecord,
  trustedOwnerDigests = cloudflareTanStackOwnerDigests
) => {
  const message = `${chunkFile} must preserve the import-safe TanStack server entry shape`;
  assertExactCloudflareStaticImportSources(program, chunkFile, [
    /^\.\/rolldown-runtime(?:-[\w-]+)?\.js$/,
    /^\.\/react(?:-[\w-]+)?\.js$/,
    /^\.\/server(?:-[\w-]+)?\.js$/,
    /^\.\/server\.edge(?:-[\w-]+)?\.js$/,
    /^\.\/telemetry(?:-[\w-]+)?\.js$/,
    /^\.\/request-completion(?:-[\w-]+)?\.js$/,
    /^\.\/request-exception-state(?:-[\w-]+)?\.js$/,
  ]);
  const declarations = program.body
    .filter((statement) => statement.type === 'VariableDeclaration')
    .flatMap((statement) => statement.declarations);
  assert(program.body.length === 16 && declarations.length === 8, message);
  const declarationNames = declarations.map((declarator) =>
    identifierName(declarator.id)
  );
  assert(
    declarationNames.join(':') ===
      'import_react:import_server_edge:noop:isAbortError:waitForReadyOrAbort:observedStreamHandler:entry:createServerEntry',
    message
  );
  assert(
    declarations.every((declarator) =>
      tanStackEntryInitializerReaders[identifierName(declarator.id)]?.(
        declarator.init
      )
    ),
    message
  );
  assert(
    program.body.flatMap(namedExportEntries).join(':') ===
      'createServerEntry,createServerEntry:default,entry',
    message
  );
  assertReviewedObservedStreamHandler(
    declarations,
    chunkFile,
    trustedOwnerDigests
  );
  assertReviewedTanStackServerOwners(program, chunkFile, trustedOwnerDigests);
  assertExactCloudflareStaticImports(program, chunkFile, manifestRecord);
};

const assertBoundedCloudflareChunkTopLevel = (
  program,
  chunkFile,
  manifestRecord,
  allowedInitializers = {}
) => {
  assert(
    program.body.every((statement) =>
      isInertTopLevelStatement(statement, allowedInitializers)
    ),
    `${chunkFile} must contain only inert top-level declarations`
  );
  assertExactCloudflareStaticImports(program, chunkFile, manifestRecord);
  const mutated = mutatedNames(program);
  for (const constructor of inertTopLevelConstructors) {
    assert(
      topLevelDeclarationsForBinding(program, constructor).length === 0 &&
        !mutated.has(constructor),
      `${chunkFile} must use trusted inert collection constructors`
    );
  }
};

const isCreateNoOpTelemetryCall = (node) =>
  nodeType(node) === 'CallExpression' &&
  identifierName(node.callee) === 'createNoOpTelemetry' &&
  node.arguments.length === 0;

const isNoOpManualSpanMember = (node) => {
  if (nodeType(node) !== 'MemberExpression') return false;
  return [
    node.computed === false,
    identifierName(node.property) === 'startManualSpan',
    isCreateNoOpTelemetryCall(node.object),
  ].every(Boolean);
};

const isNoOpManualSpanOptions = (options) => {
  if (nodeType(options) !== 'ObjectExpression') return false;
  const [property] = options.properties;
  return [
    options.properties.length === 1,
    propertyKeyName(property) === 'name',
    literalString(property?.value) === 'telemetry.noop',
  ].every(Boolean);
};

const isNoOpManualSpanCall = (node) => {
  if (nodeType(node) !== 'CallExpression') return false;
  return [
    isNoOpManualSpanMember(node.callee),
    node.arguments.length === 1,
    isNoOpManualSpanOptions(node.arguments[0]),
  ].every(Boolean);
};

const isTelemetryProxyInitializer = (node) => {
  if (nodeType(node) !== 'ObjectExpression') return false;
  const expectedProperties = [
    'captureException',
    'currentCorrelation',
    'emitLog',
    'forceFlush',
    'recordMetric',
    'setUser',
    'startManualSpan',
    'startSpan',
  ];
  const properties = node.properties.toSorted((left, right) =>
    compareCodePointStrings(
      String(propertyKeyName(left)),
      String(propertyKeyName(right))
    )
  );
  if (
    properties.map(propertyKeyName).join(':') !== expectedProperties.join(':')
  ) {
    return false;
  }
  return properties.every((property) => {
    if (propertyKeyName(property) === 'startSpan') {
      return identifierName(property.value) === 'startSpanSafely';
    }
    return inertTopLevelObjectProperty(property);
  });
};

const boundedCloudflareHelperNames = new Set([
  'bindRequestExceptionState',
  'claimRequestException',
  'createRequestExceptionCaptureState',
  'forceFlushRequestTelemetry',
  'isUnexpectedRequestFailure',
  'registerRequestCompletion',
  'snapshotRequestCompletions',
]);

const telemetryHelperNames = new Set([
  'createNoOpTelemetry',
  'getTelemetry',
  'reportTelemetryFailure',
  'setTelemetry',
]);

const assertUnmutatedCloudflareHelperChunk = (program, chunkFile) => {
  const helperNames = [
    ...boundedCloudflareHelperNames,
    ...telemetryHelperNames,
  ].filter(
    (helper) => topLevelDeclarationsForBinding(program, helper).length > 0
  );
  const mutated = mutatedNames(program);
  for (const helper of helperNames) {
    assert(
      !mutated.has(helper),
      `${chunkFile} must not mutate trusted helper ${helper}`
    );
  }
};

const assertBoundedSmallCloudflareHelperChunk = (
  program,
  chunkFile,
  manifestRecord,
  localName
) => {
  if (!boundedCloudflareHelperNames.has(localName)) return;
  const sourcePatterns = new Set([
    'forceFlushRequestTelemetry',
    'registerRequestCompletion',
    'snapshotRequestCompletions',
  ]).has(localName)
    ? [/^\.\/telemetry(?:-[\w-]+)?\.js$/]
    : [];
  assertExactCloudflareStaticImportSources(program, chunkFile, sourcePatterns);
  assertBoundedCloudflareChunkTopLevel(program, chunkFile, manifestRecord);
};

const assertBoundedTelemetryHelperChunk = (
  program,
  chunkFile,
  manifestRecord,
  localName
) => {
  if (!telemetryHelperNames.has(localName)) return;
  assertExactCloudflareStaticImportSources(program, chunkFile, []);
  assertBoundedCloudflareChunkTopLevel(program, chunkFile, manifestRecord, {
    activeAdapter: isCreateNoOpTelemetryCall,
    noOpManualSpan: isNoOpManualSpanCall,
    telemetryProxy: isTelemetryProxyInitializer,
  });
};

const assertBoundedCloudflareHelperChunk = (
  program,
  chunkFile,
  manifestRecord,
  localName
) => {
  assertUnmutatedCloudflareHelperChunk(program, chunkFile);
  assertBoundedSmallCloudflareHelperChunk(
    program,
    chunkFile,
    manifestRecord,
    localName
  );
  assertBoundedTelemetryHelperChunk(
    program,
    chunkFile,
    manifestRecord,
    localName
  );
};

const assertTrustedChunkBuiltIns = (program, chunkFile, builtIns) => {
  const mutated = mutatedNames(program);
  ['globalThis', 'self', 'window', 'global'].forEach((globalAlias) => {
    assert(
      identifierOccurrenceCount(program, globalAlias) === 0,
      `${chunkFile} must not access alternate global built-ins`
    );
  });
  Object.entries(builtIns).forEach(([builtIn, expectedOccurrences]) => {
    const message =
      expectedOccurrences === 0
        ? `${chunkFile} must not access the ${builtIn} built-in`
        : `${chunkFile} must use the trusted ${builtIn} built-in`;
    assertConditions(
      [
        topLevelDeclarationsForBinding(program, builtIn).length === 0,
        !mutated.has(builtIn) &&
          identifierOccurrenceCount(program, builtIn) === expectedOccurrences,
      ],
      message
    );
  });
};

const assertCloudflareDatabaseResponseBinding = (program, chunkFile) => {
  assertExactLocalChunkFunction(
    program,
    chunkFile,
    'bindCloudflareDatabaseToResponse'
  );
  const owner = topLevelVariableInitializer(
    program,
    'bindCloudflareDatabaseToResponse'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression' &&
      owner.async === false &&
      owner.params.length === 1 &&
      shorthandBindingSignature({ id: owner.params[0] }) ===
        expectedShorthandBindingSignature(['database', 'request', 'response']),
    `${chunkFile} database response owner must accept exact active inputs`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} database response owner must own its stream lifecycle body`
  );
  assert(
    owner.body.body.length === 5,
    `${chunkFile} database response owner must guard, pipe, and return one response`
  );
  assertCloudflareDatabaseBodyGuards(owner.body.body, chunkFile);
  const streams = directBodyVariableDeclarators(owner, 'readable');
  assertConditions(
    [
      streams.length === 1,
      streams[0].index === 2,
      streams[0].declaration.kind === 'const',
      streams[0].declaration.declarations.length === 1,
      shorthandBindingSignature(streams[0].declarator) ===
        expectedShorthandBindingSignature(['readable', 'writable']),
      nodeType(streams[0].declarator.init) === 'NewExpression',
      identifierName(streams[0].declarator.init.callee) === 'TransformStream',
      streams[0].declarator.init.arguments.length === 0,
    ],
    `${chunkFile} database response owner must create one identity stream`
  );
  assertCloudflareDatabasePipeline(owner.body.body[3], chunkFile);
  const responseReturn = owner.body.body[4];
  assertConditions(
    [
      nodeType(responseReturn) === 'ReturnStatement',
      nodeType(responseReturn.argument) === 'NewExpression',
      identifierName(responseReturn.argument.callee) === 'Response',
      responseReturn.argument.arguments.map(identifierName).join(':') ===
        'readable:response',
    ],
    `${chunkFile} database response owner must preserve response metadata and streaming`
  );
};

const assertCloudflareDatabaseChunk = (program, chunkFile) => {
  for (const helper of [
    'createHyperdriveDbClient',
    'runWithRuntimeDatabaseClient',
  ]) {
    assertExactStaticChunkHelper(
      program,
      chunkFile,
      helper,
      /^\.\/client(?:-[\w-]+)?\.js$/
    );
  }
  assertExactStaticChunkHelper(
    program,
    chunkFile,
    'validateServerConfig',
    /^\.\/backend(?:-[\w-]+)?\.js$/
  );
  assertCloudflareDatabaseClose(program, chunkFile);
  assertCloudflareDatabaseResponseBinding(program, chunkFile);
  const owner = topLevelVariableInitializer(
    program,
    'runWithCloudflareDatabase'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression' && owner.async,
    `${chunkFile} must define its Cloudflare database request owner`
  );
  assertConditions(
    [
      owner.params.length === 1,
      shorthandBindingSignature({ id: owner.params[0] }) ===
        expectedShorthandBindingSignature(['binding', 'handle', 'request']),
    ],
    `${chunkFile} database owner must accept exact active request inputs`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} database owner must own its bounded request body`
  );
  assert(
    owner.body.body.length === 3,
    `${chunkFile} database owner must directly connect then run one request scope`
  );
  const databaseOwners = directBodyVariableDeclarators(owner, 'database');
  assert(
    databaseOwners.length === 1,
    `${chunkFile} database owner must create one active database client`
  );
  assertConditions(
    [
      databaseOwners[0].index === 0,
      databaseOwners[0].declaration.kind === 'let',
      databaseOwners[0].declaration.declarations.length === 1,
      databaseOwners[0].declarator.init === null,
    ],
    `${chunkFile} database owner must declare one request-local database client`
  );
  const connectScope = owner.body.body[1];
  assert(
    nodeType(connectScope) === 'TryStatement',
    `${chunkFile} database owner must connect directly in one failure scope`
  );
  assert(
    connectScope.block.body.length === 1,
    `${chunkFile} database owner must perform one direct client assignment`
  );
  const assignmentStatement = connectScope.block.body[0];
  assert(
    nodeType(assignmentStatement) === 'ExpressionStatement',
    `${chunkFile} database owner must perform one direct client assignment`
  );
  const assignment = assignmentStatement.expression;
  assertConditions(
    [
      nodeType(assignment) === 'AssignmentExpression',
      assignment.operator === '=',
      identifierName(assignment.left) === 'database',
    ],
    `${chunkFile} database owner must perform one direct client assignment`
  );
  assert(
    nodeType(assignment.right) === 'AwaitExpression',
    `${chunkFile} database owner must await its Hyperdrive client`
  );
  const createDatabase = assignment.right.argument;
  assert(
    nodeType(createDatabase) === 'CallExpression',
    `${chunkFile} database owner must create its client from Hyperdrive`
  );
  assert(
    identifierName(createDatabase.callee) === 'createHyperdriveDbClient',
    `${chunkFile} database owner must create its client from Hyperdrive`
  );
  assert(
    createDatabase.arguments.length === 1,
    `${chunkFile} database owner must create its client from Hyperdrive`
  );
  assert(
    identifierName(createDatabase.arguments[0]) === 'binding',
    `${chunkFile} database owner must use the active Hyperdrive binding`
  );
  assertCloudflareDatabaseConnectFailure(connectScope.handler, chunkFile);
  const runtimeReturn = owner.body.body[2];
  assert(
    nodeType(runtimeReturn) === 'ReturnStatement',
    `${chunkFile} database owner must return one runtime database scope`
  );
  const runtimeScope = unwrapAwaitExpression(runtimeReturn.argument);
  assert(
    nodeType(runtimeScope) === 'CallExpression',
    `${chunkFile} database owner must return its runtime database scope`
  );
  assert(
    identifierName(runtimeScope.callee) === 'runWithRuntimeDatabaseClient',
    `${chunkFile} database owner must return its runtime database scope`
  );
  assert(
    runtimeScope.arguments.length === 2,
    `${chunkFile} database owner must return its runtime database scope`
  );
  assert(
    identifierName(runtimeScope.arguments[0]) === 'database',
    `${chunkFile} database owner must scope the active database client`
  );
  const handleScope = runtimeScope.arguments[1];
  assert(
    nodeType(handleScope) === 'ArrowFunctionExpression',
    `${chunkFile} database owner must invoke one async scoped handler`
  );
  assert(
    handleScope.async,
    `${chunkFile} database owner must invoke one async scoped handler`
  );
  assert(
    handleScope.params.length === 0,
    `${chunkFile} database owner must invoke one async scoped handler`
  );
  assert(
    nodeType(handleScope.body) === 'BlockStatement',
    `${chunkFile} database owner must own its scoped application body`
  );
  assertConditions(
    [
      handleScope.body.body.length === 1,
      nodeType(handleScope.body.body[0]) === 'TryStatement',
    ],
    `${chunkFile} database owner must keep application work in one failure scope`
  );
  const applicationScope = handleScope.body.body[0];
  assert(
    applicationScope.block.body.length === 3,
    `${chunkFile} database owner must validate, handle, and bind one response`
  );
  assertCloudflareDatabaseRequestFailure(applicationScope.handler, chunkFile);
  const validateStatement = applicationScope.block.body[0];
  assert(
    nodeType(validateStatement) === 'ExpressionStatement',
    `${chunkFile} database owner must validate directly inside its request scope`
  );
  const validateCall = validateStatement.expression;
  assert(
    nodeType(validateCall) === 'CallExpression',
    `${chunkFile} database owner must validate the Cloudflare adapter in scope`
  );
  assert(
    identifierName(validateCall.callee) === 'validateServerConfig',
    `${chunkFile} database owner must validate the Cloudflare adapter in scope`
  );
  assert(
    validateCall.arguments.length === 2,
    `${chunkFile} database owner must validate the Cloudflare adapter in scope`
  );
  assert(
    literalString(validateCall.arguments[0]) === 'cloudflare',
    `${chunkFile} database owner must validate the Cloudflare adapter in scope`
  );
  const validationOptions = ownerProperties(
    validateCall.arguments[1],
    chunkFile,
    'the Cloudflare database adapter validation'
  );
  assertConditions(
    [
      validationOptions.size === 1,
      identifierMemberSignature(validationOptions.get('databaseAdapter')) ===
        'MemberExpression:false:database:$adapter',
    ],
    `${chunkFile} database owner must validate the Cloudflare adapter in scope`
  );
  const responses = directBodyVariableDeclarators(
    applicationScope.block,
    'response'
  );
  assert(
    responses.length === 1,
    `${chunkFile} database owner must capture one application response in scope`
  );
  assert(
    responses[0].index === 1,
    `${chunkFile} database owner must capture the application response directly`
  );
  assertConditions(
    [
      responses[0].declaration.kind === 'const',
      responses[0].declaration.declarations.length === 1,
      responses[0].declaration.declarations[0] === responses[0].declarator,
    ],
    `${chunkFile} database owner must isolate one application response`
  );
  const responseInitializer = responses[0].declarator.init;
  assert(
    nodeType(responseInitializer) === 'AwaitExpression',
    `${chunkFile} database owner must await the active application handler`
  );
  const handleCall = responseInitializer.argument;
  assert(
    nodeType(handleCall) === 'CallExpression',
    `${chunkFile} database owner must invoke the active application handler in scope`
  );
  assert(
    identifierName(handleCall.callee) === 'handle',
    `${chunkFile} database owner must invoke the active application handler in scope`
  );
  assert(
    handleCall.arguments.length === 0,
    `${chunkFile} database owner must invoke the active application handler in scope`
  );
  const bindingReturn = applicationScope.block.body[2];
  assert(
    nodeType(bindingReturn) === 'ReturnStatement',
    `${chunkFile} database owner must bind database lifetime to its response`
  );
  const responseBinding = unwrapAwaitExpression(bindingReturn.argument);
  assert(
    nodeType(responseBinding) === 'CallExpression',
    `${chunkFile} database owner must return its response lifetime binding`
  );
  assert(
    identifierName(responseBinding.callee) ===
      'bindCloudflareDatabaseToResponse',
    `${chunkFile} database owner must return its response lifetime binding`
  );
  assert(
    responseBinding.arguments.length === 1,
    `${chunkFile} database owner must return its response lifetime binding`
  );
  const [bindingInput = {}] = responseBinding.arguments;
  const bindingProperties = ownerProperties(
    bindingInput,
    chunkFile,
    'the Cloudflare database response lifetime owner'
  );
  assert(
    bindingProperties.size === 3,
    `${chunkFile} database response lifetime owner must receive exact inputs`
  );
  for (const name of ['database', 'request', 'response']) {
    assert(
      identifierName(bindingProperties.get(name)) === name,
      `${chunkFile} database response lifetime owner must receive active ${name}`
    );
  }
  assertTrustedChunkBuiltIns(program, chunkFile, {
    Response: 1,
    TransformStream: 1,
    TypeError: 1,
  });
};

const assertCloudflareDatabaseConnectFailure = (handler, chunkFile) => {
  const preserveMessage = `${chunkFile} database owner must preserve connection failures`;
  assert(nodeType(handler) === 'CatchClause', preserveMessage);
  assertConditions(
    [
      identifierName(handler.param) === 'failure',
      handler.body.body.length === 2,
    ],
    preserveMessage
  );
  const captureStatement = handler.body.body[0];
  assert(
    nodeType(captureStatement) === 'ExpressionStatement',
    `${chunkFile} database owner must report connection failures`
  );
  const capture = captureStatement.expression;
  assert(
    nodeType(capture) === 'CallExpression',
    `${chunkFile} database owner must report connection failures`
  );
  assertConditions(
    [
      identifierName(capture.callee) === 'captureDatabaseConnectionFailure',
      capture.arguments.length === 1,
      identifierName(capture.arguments[0]) === 'failure',
    ],
    `${chunkFile} database owner must report connection failures`
  );
  const rethrow = handler.body.body[1];
  assertConditions(
    [
      nodeType(rethrow) === 'ThrowStatement',
      identifierName(rethrow.argument) === 'failure',
    ],
    `${chunkFile} database owner must rethrow connection failures`
  );
};

const assertCloudflareDatabaseRequestFailure = (handler, chunkFile) => {
  assertConditions(
    [
      nodeType(handler) === 'CatchClause',
      identifierName(handler?.param) === 'failure',
      handler?.body.body.length === 2,
    ],
    `${chunkFile} database owner must preserve scoped request failures`
  );
  const close = handler.body.body[0].expression;
  assert(
    nodeType(close) === 'AwaitExpression',
    `${chunkFile} database owner must await cleanup after request failure`
  );
  assertConditions(
    [
      nodeType(close.argument) === 'CallExpression',
      identifierName(close.argument?.callee) === 'closeDatabase',
      close.argument?.arguments.length === 1,
      identifierName(close.argument?.arguments[0]) === 'database',
    ],
    `${chunkFile} database owner must close the active client after request failure`
  );
  const rethrow = handler.body.body[1];
  assertConditions(
    [
      nodeType(rethrow) === 'ThrowStatement',
      identifierName(rethrow.argument) === 'failure',
    ],
    `${chunkFile} database owner must rethrow scoped request failures`
  );
};

const assertEmptyObjectReturn = (statement, filePath, label) => {
  const message = `${filePath} ${label} must return an empty safe fallback`;
  assert(nodeType(statement) === 'ReturnStatement', message);
  assert(nodeType(statement.argument) === 'ObjectExpression', message);
  assert(
    statement.argument.properties.length === 0,
    `${filePath} ${label} must return an empty safe fallback`
  );
};

const assertCloudflareTelemetryGuard = (guard, chunkFile) => {
  assert(
    nodeType(guard) === 'IfStatement',
    `${chunkFile} request telemetry owner must guard optional Sentry setup`
  );
  assert(
    guard.alternate === null,
    `${chunkFile} request telemetry owner must guard optional Sentry setup`
  );
  const condition = guard.test;
  assert(
    nodeType(condition) === 'LogicalExpression',
    `${chunkFile} request telemetry owner must guard DSN and isolation readiness`
  );
  assert(
    condition.operator === '||',
    `${chunkFile} request telemetry owner must guard DSN and isolation readiness`
  );
  assertConditions(
    [
      nodeType(condition.left) === 'UnaryExpression',
      condition.left.operator === '!',
      identifierMemberSignature(condition.left.argument) ===
        'MemberExpression:false:environment:SENTRY_DSN',
    ],
    `${chunkFile} request telemetry owner must guard the active Sentry DSN`
  );
  assertConditions(
    [
      nodeType(condition.right) === 'UnaryExpression',
      condition.right.operator === '!',
      identifierName(condition.right.argument) ===
        'sentryRequestIsolationReady',
    ],
    `${chunkFile} request telemetry owner must guard request isolation readiness`
  );
  const fallback = directGuardFallback(guard.consequent);
  assert(
    fallback !== undefined,
    `${chunkFile} request telemetry guard must have one safe fallback`
  );
  assertEmptyObjectReturn(fallback, chunkFile, 'request telemetry guard');
};

const directGuardFallback = (consequent) => {
  if (consequent.type === 'ReturnStatement') return consequent;
  if (consequent.type !== 'BlockStatement') return undefined;
  if (consequent.body.length !== 1) return undefined;
  return consequent.body[0];
};

const mergedDeclaratorsAreExact = (first, second) =>
  first.declaration.declarations.length === 2 &&
  first.declaration.declarations[0] === first.declarator &&
  first.declaration.declarations[1] === second.declarator;

const separateDeclaratorsAreSequential = (first, second) =>
  first.declaration.declarations.length === 1 &&
  second.declaration.declarations.length === 1 &&
  second.index === first.index + 1;

const declaratorsAreExactlySequential = (first, second) =>
  first.declaration === second.declaration
    ? mergedDeclaratorsAreExact(first, second)
    : separateDeclaratorsAreSequential(first, second);

const assertCloudflareTelemetrySuccess = (scope, chunkFile) => {
  const options = directBodyVariableDeclarators(scope.block, 'sentryOptions');
  assert(
    options.length === 1,
    `${chunkFile} request telemetry owner must create one Sentry options value`
  );
  assertConditions(
    [options[0].index === 0, options[0].declaration.kind === 'const'],
    `${chunkFile} request telemetry owner must create Sentry options directly`
  );
  const createOptions = unwrapAwaitExpression(options[0].declarator.init);
  assert(
    nodeType(createOptions) === 'CallExpression',
    `${chunkFile} request telemetry owner must create Cloudflare Sentry options`
  );
  assert(
    identifierName(createOptions.callee) === 'createCloudflareSentryOptions',
    `${chunkFile} request telemetry owner must create Cloudflare Sentry options`
  );
  assert(
    createOptions.arguments.map(identifierName).join(':') ===
      'sentry:request:environment',
    `${chunkFile} request telemetry owner must create options from active request inputs`
  );
  const adapters = directBodyVariableDeclarators(
    scope.block,
    'sentryTelemetry'
  );
  assert(
    adapters.length === 1,
    `${chunkFile} request telemetry owner must create one Sentry telemetry adapter`
  );
  assertConditions(
    [
      adapters[0].declaration.kind === 'const',
      declaratorsAreExactlySequential(options[0], adapters[0]),
    ],
    `${chunkFile} request telemetry owner must create its Sentry adapter directly`
  );
  const createAdapter = unwrapAwaitExpression(adapters[0].declarator.init);
  assert(
    nodeType(createAdapter) === 'CallExpression',
    `${chunkFile} request telemetry owner must create its Sentry telemetry adapter`
  );
  assert(
    identifierName(createAdapter.callee) === 'createSentryTelemetryAdapter',
    `${chunkFile} request telemetry owner must create its Sentry telemetry adapter`
  );
  assert(
    identifierName(createAdapter.arguments[0]) === 'sentry',
    `${chunkFile} request telemetry owner must use the active Sentry API`
  );
  const adapterOptions = ownerProperties(
    createAdapter.arguments[1],
    chunkFile,
    'the Sentry telemetry adapter'
  );
  assertConditions(
    [
      adapterOptions.size === 1,
      literalString(adapterOptions.get('flushOwner')) === 'request-wrapper',
    ],
    `${chunkFile} Sentry telemetry adapter must leave flushing to the request wrapper`
  );
  const installIndex = adapters[0].index + 1;
  assert(
    scope.block.body.length === installIndex + 2,
    `${chunkFile} request telemetry owner must configure one Sentry adapter chain`
  );
  const installStatement = scope.block.body[installIndex];
  assert(
    nodeType(installStatement) === 'ExpressionStatement',
    `${chunkFile} request telemetry owner must install its adapter chain directly`
  );
  const installChain = installStatement.expression;
  assert(
    nodeType(installChain) === 'CallExpression',
    `${chunkFile} request telemetry owner must install its adapter chain directly`
  );
  assert(
    identifierName(installChain.callee) === 'setTelemetry',
    `${chunkFile} request telemetry owner must install its adapter chain directly`
  );
  const createChain = installChain.arguments[0];
  assert(
    nodeType(createChain) === 'CallExpression',
    `${chunkFile} request telemetry owner must install the active adapter chain`
  );
  assert(
    identifierName(createChain.callee) === 'createTelemetryAdapterChain',
    `${chunkFile} request telemetry owner must install the active adapter chain`
  );
  const chainAdapters = createChain.arguments[0];
  assert(
    nodeType(chainAdapters) === 'ArrayExpression',
    `${chunkFile} request telemetry owner must chain native and Sentry adapters`
  );
  assert(
    chainAdapters.elements.map(identifierName).join(':') ===
      'nativeTelemetry:sentryTelemetry',
    `${chunkFile} request telemetry owner must chain native and Sentry adapters`
  );
  const successReturn = scope.block.body[installIndex + 1];
  assert(
    nodeType(successReturn) === 'ReturnStatement',
    `${chunkFile} request telemetry owner must return validated Sentry options`
  );
  assert(
    shorthandObjectSignature(successReturn.argument) ===
      expectedShorthandObjectSignature(['sentryOptions']),
    `${chunkFile} request telemetry owner must return validated Sentry options`
  );
};

const assertCloudflareTelemetryFailure = (scope, chunkFile) => {
  assert(
    nodeType(scope.handler) === 'CatchClause',
    `${chunkFile} request telemetry owner must classify Sentry setup failures`
  );
  assert(
    identifierName(scope.handler.param) === 'failure',
    `${chunkFile} request telemetry owner must classify Sentry setup failures`
  );
  assert(
    scope.handler.body.body.length === 2,
    `${chunkFile} request telemetry owner must report and safely degrade setup failures`
  );
  const reportCall = scope.handler.body.body[0].expression;
  assert(
    nodeType(reportCall) === 'CallExpression',
    `${chunkFile} request telemetry owner must report Sentry setup failures`
  );
  assert(
    identifierName(reportCall.callee) === 'reportTelemetryFailure',
    `${chunkFile} request telemetry owner must report Sentry setup failures`
  );
  assertConditions(
    [
      literalString(reportCall.arguments[0]) === 'sentry.cloudflare.configure',
      identifierName(reportCall.arguments[1]) === 'failure',
    ],
    `${chunkFile} request telemetry owner must report bounded Sentry setup diagnostics`
  );
  assertEmptyObjectReturn(
    scope.handler.body.body[1],
    chunkFile,
    'request telemetry failure path'
  );
};

const assertCloudflareRequestTelemetryChunkBehavior = (program, chunkFile) => {
  assertExactStaticChunkHelper(
    program,
    chunkFile,
    'setTelemetry',
    /^\.\/telemetry(?:-[\w-]+)?\.js$/
  );
  for (const helper of [
    'createCloudflareSentryOptions',
    'createSentryTelemetryAdapter',
    'createTelemetryAdapterChain',
  ]) {
    assertExactLocalChunkFunction(program, chunkFile, helper);
  }
  const owner = topLevelVariableInitializer(
    program,
    'configureCloudflareRequestTelemetry'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression',
    `${chunkFile} request telemetry owner must accept exact active inputs`
  );
  assertConditions(
    [
      owner.async === false,
      owner.params.length === 1,
      shorthandBindingSignature({ id: owner.params[0] }) ===
        expectedShorthandBindingSignature([
          'environment',
          'nativeTelemetry',
          'request',
          'sentry',
          'sentryRequestIsolationReady',
        ]),
    ],
    `${chunkFile} request telemetry owner must accept exact active inputs`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} request telemetry owner must own its configuration body`
  );
  assert(
    owner.body.body.length === 3,
    `${chunkFile} request telemetry owner must install, guard, and configure telemetry`
  );
  const initialInstall = owner.body.body[0].expression;
  assert(
    nodeType(initialInstall) === 'CallExpression',
    `${chunkFile} request telemetry owner must install native telemetry first`
  );
  assertConditions(
    [
      identifierName(initialInstall.callee) === 'setTelemetry',
      identifierName(initialInstall.arguments[0]) === 'nativeTelemetry',
    ],
    `${chunkFile} request telemetry owner must install native telemetry first`
  );
  assertCloudflareTelemetryGuard(owner.body.body[1], chunkFile);
  const scope = owner.body.body[2];
  assertConditions(
    [nodeType(scope) === 'TryStatement', scope.finalizer === null],
    `${chunkFile} request telemetry owner must isolate optional Sentry setup`
  );
  assertCloudflareTelemetrySuccess(scope, chunkFile);
  assertCloudflareTelemetryFailure(scope, chunkFile);
};

const assertCloudflareIsolationInitializer = (program, chunkFile) => {
  assertExactLocalChunkFunction(
    program,
    chunkFile,
    'initializeCloudflareSentryIsolation'
  );
  const owner = topLevelVariableInitializer(
    program,
    'initializeCloudflareSentryIsolation'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression',
    `${chunkFile} must define Sentry async-context isolation for the active API`
  );
  assert(
    !owner.async && owner.params.map(identifierName).join(':') === 'api',
    `${chunkFile} must define Sentry async-context isolation for the active API`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} Sentry isolation owner must own its fail-safe setup body`
  );
  assert(
    owner.body.body.length === 1,
    `${chunkFile} Sentry isolation owner must have one fail-safe setup scope`
  );
  assert(
    nodeType(owner.body.body[0]) === 'TryStatement',
    `${chunkFile} Sentry isolation owner must have one fail-safe setup scope`
  );
  const scope = owner.body.body[0];
  assertConditions(
    [scope.finalizer === null, scope.block.body.length === 2],
    `${chunkFile} Sentry isolation owner must initialize once then report readiness`
  );
  const initializeCall = scope.block.body[0].expression;
  assert(
    nodeType(initializeCall) === 'CallExpression',
    `${chunkFile} Sentry isolation owner must install the SDK async-context strategy`
  );
  assertConditions(
    [
      identifierMemberSignature(initializeCall.callee) ===
        'MemberExpression:false:api:setAsyncLocalStorageAsyncContextStrategy',
      initializeCall.arguments.length === 0,
    ],
    `${chunkFile} Sentry isolation owner must install the SDK async-context strategy`
  );
  assert(
    scope.block.body[1].type === 'ReturnStatement',
    `${chunkFile} Sentry isolation owner must report successful readiness`
  );
  assert(
    scope.block.body[1].argument.value === true,
    `${chunkFile} Sentry isolation owner must report successful readiness`
  );
  assert(
    nodeType(scope.handler) === 'CatchClause',
    `${chunkFile} Sentry isolation owner must classify initialization failure`
  );
  assertConditions(
    [
      identifierName(scope.handler.param) === 'failure',
      scope.handler.body.body.length === 2,
    ],
    `${chunkFile} Sentry isolation owner must classify initialization failure`
  );
  const reportCall = scope.handler.body.body[0].expression;
  assert(
    nodeType(reportCall) === 'CallExpression',
    `${chunkFile} Sentry isolation owner must report bounded initialization diagnostics`
  );
  assertConditions(
    [
      identifierName(reportCall.callee) === 'reportTelemetryFailure',
      literalString(reportCall.arguments[0]) ===
        'sentry.cloudflare.async_context',
      identifierName(reportCall.arguments[1]) === 'failure',
    ],
    `${chunkFile} Sentry isolation owner must report bounded initialization diagnostics`
  );
  assert(
    scope.handler.body.body[1].type === 'ReturnStatement',
    `${chunkFile} Sentry isolation owner must fail readiness closed`
  );
  assert(
    scope.handler.body.body[1].argument.value === false,
    `${chunkFile} Sentry isolation owner must fail readiness closed`
  );
};

const assertCloudflareSentryApplicationChunkOwner = (program, chunkFile) => {
  const owner = topLevelVariableInitializer(
    program,
    'initializeCloudflareSentryApplication'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression' &&
      owner.async &&
      owner.params.map(identifierName).join(':') === 'api:loadApplication',
    `${chunkFile} Sentry application owner must accept exact initialization inputs`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} Sentry application owner must own its initialization body`
  );
  assert(
    owner.body.body.length === 2,
    `${chunkFile} Sentry application owner must initialize before loading the application`
  );
  const readiness = directBodyVariableDeclarators(
    owner,
    'sentryRequestIsolationReady'
  );
  assert(
    readiness.length === 1,
    `${chunkFile} Sentry application owner must establish isolation first`
  );
  assert(
    readiness[0].index === 0,
    `${chunkFile} Sentry application owner must establish isolation first`
  );
  assertConditions(
    [
      readiness[0].declaration.kind === 'const',
      readiness[0].declaration.declarations.length === 1,
      readiness[0].declaration.declarations[0] === readiness[0].declarator,
    ],
    `${chunkFile} Sentry application owner must isolate its readiness state`
  );
  const initialize = readiness[0].declarator.init;
  assert(
    nodeType(initialize) === 'CallExpression',
    `${chunkFile} Sentry application owner must initialize the active SDK isolation`
  );
  assertConditions(
    [
      identifierName(initialize.callee) ===
        'initializeCloudflareSentryIsolation',
      initialize.arguments.length === 1,
      identifierName(initialize.arguments[0]) === 'api',
    ],
    `${chunkFile} Sentry application owner must initialize the active SDK isolation`
  );
  const ownerReturn = owner.body.body[1];
  assert(
    ownerReturn.type === 'ReturnStatement',
    `${chunkFile} Sentry application owner must return its initialized application`
  );
  const returned = ownerProperties(
    ownerReturn.argument,
    chunkFile,
    'the Sentry application owner result'
  );
  assert(
    returned.size === 2,
    `${chunkFile} Sentry application owner must return exact ownership state`
  );
  const applicationLoad = returned.get('application');
  assert(
    nodeType(applicationLoad) === 'AwaitExpression',
    `${chunkFile} Sentry application owner must await its active application loader`
  );
  const loadApplication = applicationLoad.argument;
  assert(
    nodeType(loadApplication) === 'CallExpression',
    `${chunkFile} Sentry application owner must invoke its active application loader`
  );
  assertConditions(
    [
      identifierName(loadApplication.callee) === 'loadApplication',
      loadApplication.arguments.length === 0,
    ],
    `${chunkFile} Sentry application owner must invoke its active application loader`
  );
  assert(
    identifierName(returned.get('sentryRequestIsolationReady')) ===
      'sentryRequestIsolationReady',
    `${chunkFile} Sentry application owner must return application and isolation readiness`
  );
};

const identityExpression = (node) => node;
const chainExpressionValue = (node) => node.expression;
const chainExpressionReaders = { ChainExpression: chainExpressionValue };
const unwrapChainExpression = (node) =>
  (chainExpressionReaders[nodeType(node)] ?? identityExpression)(node);

const assertApplicationOutcomeGuard = (
  statement,
  { consequentType, memberName, optional, outcomeType },
  chunkFile
) => {
  assert(
    nodeType(statement) === 'IfStatement',
    `${chunkFile} Sentry request owner must preserve ${outcomeType} application outcomes`
  );
  const test = statement.test;
  const consequence = statement.consequent;
  assertConditions(
    [
      statement.alternate === null,
      nodeType(test) === 'BinaryExpression',
      nodeType(consequence) === consequentType,
    ],
    `${chunkFile} Sentry request owner must preserve ${outcomeType} application outcomes`
  );
  const outcomeMember = unwrapChainExpression(test.left);
  assertConditions(
    [
      test.operator === '===',
      identifierMemberSignature(outcomeMember) ===
        'MemberExpression:false:applicationOutcome:type',
      outcomeMember.optional === optional,
      literalString(test.right) === outcomeType,
      identifierMemberSignature(consequence.argument) ===
        `MemberExpression:false:applicationOutcome:${memberName}`,
    ],
    `${chunkFile} Sentry request owner must preserve ${outcomeType} application outcomes`
  );
};

const assertCloudflareSentryRequestFailure = (requestScope, chunkFile) => {
  const handler = requestScope.handler;
  assertConditions(
    [
      requestScope.finalizer === null,
      nodeType(handler) === 'CatchClause',
      identifierName(handler?.param) === 'failure',
      handler?.body.body.length === 2,
    ],
    `${chunkFile} Sentry request owner must isolate SDK failures`
  );
  assertApplicationOutcomeGuard(
    handler.body.body[0],
    {
      consequentType: 'ThrowStatement',
      memberName: 'failure',
      optional: true,
      outcomeType: 'failed',
    },
    chunkFile
  );
  const report = handler.body.body[1].expression;
  assertConditions(
    [
      nodeType(report) === 'CallExpression',
      identifierName(report.callee) === 'reportTelemetryFailure',
      report.arguments.length === 2,
      literalString(report.arguments[0]) === 'sentry.cloudflare.request',
      identifierName(report.arguments[1]) === 'failure',
    ],
    `${chunkFile} Sentry request owner must report bounded SDK failure diagnostics`
  );
};

const assertCloudflareSentrySkippedReport = (statement, chunkFile) => {
  const report = statement?.expression;
  const skipped = report?.arguments[1];
  assertConditions(
    [
      nodeType(statement) === 'ExpressionStatement',
      nodeType(report) === 'CallExpression',
      identifierName(report?.callee) === 'reportTelemetryFailure',
      report?.arguments.length === 2,
      literalString(report?.arguments[0]) === 'sentry.cloudflare.request',
      nodeType(skipped) === 'NewExpression',
      identifierName(skipped?.callee) === 'Error',
      skipped?.arguments.length === 1,
      literalString(skipped?.arguments[0]) ===
        'Sentry request wrapper skipped application handler',
    ],
    `${chunkFile} Sentry request owner must report a skipped SDK application path`
  );
};

const assertCloudflareSentryLifecycleRequestHelper = (program, chunkFile) => {
  const helper = 'sentryLifecycleRequest';
  const ownerMessage = `${chunkFile} Sentry lifecycle request owner must bound request normalization`;
  assertExactLocalChunkFunction(program, chunkFile, helper);
  assert(
    identifierOccurrenceCount(program, helper) === 2,
    `${chunkFile} must not alias trusted helper ${helper}`
  );
  const owner = topLevelVariableInitializer(program, helper);
  assertConditions(
    [
      nodeType(owner) === 'ArrowFunctionExpression',
      nodeType(owner.body) === 'BlockStatement',
    ],
    ownerMessage
  );
  assertConditions(
    [
      owner.params.map(identifierName).join(':') === 'request',
      owner.async === false,
      owner.body.body.length === 2,
    ],
    ownerMessage
  );
  const [methodGuard, normalizedReturn] = owner.body.body;
  assertConditions(
    [
      nodeType(methodGuard) === 'IfStatement',
      nodeType(normalizedReturn) === 'ReturnStatement',
    ],
    `${chunkFile} Sentry lifecycle request owner must preserve bodyful methods`
  );
  const methodTest = methodGuard.test;
  assert(
    nodeType(methodTest) === 'LogicalExpression',
    `${chunkFile} Sentry lifecycle request owner must preserve bodyful methods`
  );
  const [headCheck, optionsCheck] = [methodTest.left, methodTest.right];
  assertConditions(
    [
      methodGuard.alternate === null,
      methodTest.operator === '&&',
      nodeType(headCheck) === 'BinaryExpression',
      nodeType(optionsCheck) === 'BinaryExpression',
      nodeType(methodGuard.consequent) === 'ReturnStatement',
    ],
    `${chunkFile} Sentry lifecycle request owner must preserve bodyful methods`
  );
  assertConditions(
    [
      headCheck.operator === '!==',
      identifierMemberSignature(headCheck.left) ===
        'MemberExpression:false:request:method',
      literalString(headCheck.right) === 'HEAD',
      optionsCheck.operator === '!==',
      identifierMemberSignature(optionsCheck.left) ===
        'MemberExpression:false:request:method',
      literalString(optionsCheck.right) === 'OPTIONS',
      identifierName(methodGuard.consequent.argument) === 'request',
    ],
    `${chunkFile} Sentry lifecycle request owner must preserve bodyful methods`
  );
  const normalized = normalizedReturn.argument;
  assertConditions(
    [
      nodeType(normalized) === 'NewExpression',
      identifierName(normalized.callee) === 'Request',
      normalized.arguments.length === 2,
      identifierMemberSignature(normalized.arguments[0]) ===
        'MemberExpression:false:request:url',
    ],
    `${chunkFile} Sentry lifecycle request owner must normalize bodyless methods`
  );
  const normalizedOptions = ownerProperties(
    normalized.arguments[1],
    chunkFile,
    'the Sentry lifecycle request normalization'
  );
  assertConditions(
    [
      normalizedOptions.size === 2,
      identifierMemberSignature(normalizedOptions.get('headers')) ===
        'MemberExpression:false:request:headers',
      literalString(normalizedOptions.get('method')) === 'GET',
    ],
    `${chunkFile} Sentry lifecycle request owner must preserve headers and normalize its method`
  );
};

const assertCloudflareSentinelSettle = (settle, chunkFile) => {
  const message = `${chunkFile} Sentry sentinel owner must close its stream on completion`;
  assert(nodeType(settle) === 'ArrowFunctionExpression', message);
  assert(nodeType(settle.body) === 'CallExpression', message);
  assertConditions(
    [
      settle.params.length === 0,
      settle.expression,
      identifierMemberSignature(settle.body.callee) ===
        'MemberExpression:false:controller:close',
      settle.body.arguments.length === 0,
    ],
    message
  );
};

const assertCloudflareSentinelMetadata = (responseOptions, chunkFile) => {
  const options = ownerProperties(
    responseOptions,
    chunkFile,
    'the Sentry sentinel response'
  );
  const headers = ownerProperties(
    options.get('headers'),
    chunkFile,
    'the Sentry sentinel response headers'
  );
  const status = options.get('status');
  assert(
    nodeType(status) === 'Literal',
    `${chunkFile} Sentry sentinel owner must emit exact bounded response metadata`
  );
  assertConditions(
    [
      options.size === 2,
      headers.size === 1,
      literalString(headers.get('content-type')) ===
        'text/plain; charset=utf-8',
      status.value === 200,
    ],
    `${chunkFile} Sentry sentinel owner must emit exact bounded response metadata`
  );
};

const assertCloudflareSentrySentinelHelper = (program, chunkFile) => {
  const helper = 'sentrySentinelResponse';
  const ownerMessage = `${chunkFile} Sentry sentinel owner must create one bounded streaming response`;
  assertExactLocalChunkFunction(program, chunkFile, helper);
  assert(
    identifierOccurrenceCount(program, helper) === 2,
    `${chunkFile} must not alias trusted helper ${helper}`
  );
  const owner = topLevelVariableInitializer(program, helper);
  assertConditions(
    [
      nodeType(owner) === 'ArrowFunctionExpression',
      nodeType(owner.body) === 'NewExpression',
    ],
    ownerMessage
  );
  assertConditions(
    [
      owner.params.map(identifierName).join(':') === 'applicationCompletion',
      owner.async === false,
      owner.expression,
      identifierName(owner.body.callee) === 'Response',
      owner.body.arguments.length === 2,
    ],
    ownerMessage
  );
  const [stream, responseOptions] = owner.body.arguments;
  assert(
    nodeType(stream) === 'NewExpression',
    `${chunkFile} Sentry sentinel owner must own one completion stream`
  );
  assertConditions(
    [
      identifierName(stream.callee) === 'ReadableStream',
      stream.arguments.length === 1,
    ],
    `${chunkFile} Sentry sentinel owner must own one completion stream`
  );
  const streamOwner = ownerProperties(
    stream.arguments[0],
    chunkFile,
    'the Sentry sentinel completion stream'
  );
  const start = streamOwner.get('start');
  assert(
    nodeType(start) === 'FunctionExpression',
    `${chunkFile} Sentry sentinel owner must own one stream start callback`
  );
  assertConditions(
    [
      streamOwner.size === 1,
      start.async === false,
      start.generator === false,
      start.params.map(identifierName).join(':') === 'controller',
      nodeType(start.body) === 'BlockStatement',
    ],
    `${chunkFile} Sentry sentinel owner must own one stream start callback`
  );
  assert(
    start.body.body.length === 1,
    `${chunkFile} Sentry sentinel owner must own one stream start callback`
  );
  const completion = start.body.body[0].expression;
  assert(
    nodeType(completion) === 'CallExpression',
    `${chunkFile} Sentry sentinel owner must settle on every application completion`
  );
  assertConditions(
    [
      identifierMemberSignature(completion.callee) ===
        'MemberExpression:false:applicationCompletion:then',
      completion.arguments.length === 2,
    ],
    `${chunkFile} Sentry sentinel owner must settle on every application completion`
  );
  completion.arguments.forEach((settle) =>
    assertCloudflareSentinelSettle(settle, chunkFile)
  );
  assertCloudflareSentinelMetadata(responseOptions, chunkFile);
};

const assertCloudflareSentryRequestOptions = (options, chunkFile) => {
  assert(
    nodeType(options) === 'ObjectExpression',
    `${chunkFile} Sentry request owner must pass exact active request options`
  );
  assert(
    options.properties.length === 2,
    `${chunkFile} Sentry request owner must pass exact active request options`
  );
  const [baseOptions, lifecycleRequest] = options.properties;
  assertConditions(
    [
      nodeType(baseOptions) === 'SpreadElement',
      identifierName(baseOptions.argument) === 'requestOptions',
      nodeType(lifecycleRequest) === 'Property',
    ],
    `${chunkFile} Sentry request owner must pass exact active request options`
  );
  const requestCall = lifecycleRequest.value;
  assertConditions(
    [
      lifecycleRequest.computed === false,
      propertyKeyName(lifecycleRequest) === 'request',
      nodeType(requestCall) === 'CallExpression',
    ],
    `${chunkFile} Sentry request owner must pass exact active request options`
  );
  assertConditions(
    [
      identifierName(requestCall.callee) === 'sentryLifecycleRequest',
      requestCall.arguments.length === 1,
      identifierName(requestCall.arguments[0]) === 'request',
    ],
    `${chunkFile} Sentry request owner must pass exact active request options`
  );
};

const assertCloudflareSentryRequestHandler = (requestHandler, chunkFile) => {
  const bodyMessage = `${chunkFile} Sentry request wrapper must own its bounded application body`;
  assert(nodeType(requestHandler) === 'ArrowFunctionExpression', bodyMessage);
  assert(nodeType(requestHandler.body) === 'BlockStatement', bodyMessage);
  assertConditions(
    [
      requestHandler.async,
      requestHandler.params.length === 0,
      requestHandler.body.body.length === 3,
    ],
    bodyMessage
  );
  const [capture, failureGuard, sentinelReturn] = requestHandler.body.body;
  assert(
    nodeType(capture) === 'ExpressionStatement',
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  const requestExecution = capture.expression;
  assertConditions(
    [
      nodeType(requestExecution) === 'AssignmentExpression',
      nodeType(requestExecution.right) === 'AwaitExpression',
    ],
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  const requestExecutionCall = requestExecution.right.argument;
  assertConditions(
    [
      requestExecution.operator === '=',
      identifierName(requestExecution.left) === 'applicationOutcome',
      nodeType(requestExecutionCall) === 'CallExpression',
    ],
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  assertConditions(
    [
      identifierName(requestExecutionCall.callee) === 'runApplicationOnce',
      requestExecutionCall.arguments.length === 0,
    ],
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  assertApplicationOutcomeGuard(
    failureGuard,
    {
      consequentType: 'ThrowStatement',
      memberName: 'failure',
      optional: false,
      outcomeType: 'failed',
    },
    chunkFile
  );
  assert(
    nodeType(sentinelReturn) === 'ReturnStatement',
    `${chunkFile} Sentry request wrapper must return one bounded sentinel response`
  );
  const sentinel = sentinelReturn.argument;
  assert(
    nodeType(sentinel) === 'CallExpression',
    `${chunkFile} Sentry request wrapper must return one bounded sentinel response`
  );
  assertConditions(
    [
      identifierName(sentinel.callee) === 'sentrySentinelResponse',
      sentinel.arguments.length === 1,
    ],
    `${chunkFile} Sentry request wrapper must return one bounded sentinel response`
  );
  const settled = sentinel.arguments[0];
  assert(
    nodeType(settled) === 'CallExpression',
    `${chunkFile} Sentry request wrapper must await bounded request completions`
  );
  const [snapshot] = settled.arguments;
  assert(
    nodeType(snapshot) === 'CallExpression',
    `${chunkFile} Sentry request wrapper must await bounded request completions`
  );
  assertConditions(
    [
      identifierMemberSignature(settled.callee) ===
        'MemberExpression:false:Promise:allSettled',
      settled.arguments.length === 1,
      identifierName(snapshot.callee) === 'snapshotRequestCompletions',
      snapshot.arguments.length === 1,
      identifierName(snapshot.arguments[0]) === 'request',
    ],
    `${chunkFile} Sentry request wrapper must await bounded request completions`
  );
};

const cloudflareSentryCompletionOwner = (statement, chunkFile) => {
  const completionMessage = `${chunkFile} Sentry request owner must bound its SDK response completion`;
  assert(nodeType(statement) === 'IfStatement', completionMessage);
  assertConditions(
    [
      statement.alternate === null,
      identifierMemberSignature(statement.test) ===
        'MemberExpression:false:sentryResponse:body',
      nodeType(statement.consequent) === 'BlockStatement',
    ],
    completionMessage
  );
  assert(statement.consequent.body.length === 2, completionMessage);
  const [completionDeclaration, registration] = statement.consequent.body;
  assert(
    nodeType(completionDeclaration) === 'VariableDeclaration',
    `${chunkFile} Sentry request owner must own one SDK response completion`
  );
  assertConditions(
    [
      completionDeclaration.kind === 'const',
      completionDeclaration.declarations.length === 1,
    ],
    `${chunkFile} Sentry request owner must own one SDK response completion`
  );
  const [completionDeclarator] = completionDeclaration.declarations;
  assert(
    identifierName(completionDeclarator.id) === 'sentryCompletion',
    `${chunkFile} Sentry request owner must own one SDK response completion`
  );
  return { completionDeclarator, registration };
};

const cloudflareSentryDrainCalls = (completionDeclarator, chunkFile) => {
  const message = `${chunkFile} Sentry request owner must drain one bounded SDK response`;
  const catchCall = completionDeclarator.init;
  assert(nodeType(catchCall) === 'CallExpression', message);
  assert(nodeType(catchCall.callee) === 'MemberExpression', message);
  const thenCall = catchCall.callee.object;
  assert(nodeType(thenCall) === 'CallExpression', message);
  assert(nodeType(thenCall.callee) === 'MemberExpression', message);
  const arrayBufferCall = thenCall.callee.object;
  assert(nodeType(arrayBufferCall) === 'CallExpression', message);
  assert(nodeType(arrayBufferCall.callee) === 'MemberExpression', message);
  assertConditions(
    [
      catchCall.callee.computed === false,
      identifierName(catchCall.callee.property) === 'catch',
      catchCall.arguments.length === 1,
      thenCall.callee.computed === false,
      identifierName(thenCall.callee.property) === 'then',
      thenCall.arguments.length === 1,
      identifierMemberSignature(arrayBufferCall.callee) ===
        'MemberExpression:false:sentryResponse:arrayBuffer',
      arrayBufferCall.arguments.length === 0,
    ],
    message
  );
  return { catchCall, thenCall };
};

const assertCloudflareSentryDrainSettle = (settle, chunkFile) => {
  const message = `${chunkFile} Sentry request owner must settle its SDK response drain`;
  assert(nodeType(settle) === 'ArrowFunctionExpression', message);
  assert(nodeType(settle.body) === 'UnaryExpression', message);
  assertConditions(
    [
      settle.params.length === 0,
      settle.body.operator === 'void',
      settle.body.argument.value === 0,
    ],
    message
  );
};

const assertCloudflareSentryDrainIsolation = (isolate, chunkFile) => {
  const message = `${chunkFile} Sentry request owner must isolate its SDK response drain`;
  assert(nodeType(isolate) === 'ArrowFunctionExpression', message);
  assert(nodeType(isolate.body) === 'BlockStatement', message);
  assertConditions(
    [
      isolate.params.map(identifierName).join(':') === 'failure',
      isolate.body.body.length === 1,
    ],
    message
  );
  const report = isolate.body.body[0].expression;
  assert(
    nodeType(report) === 'CallExpression',
    `${chunkFile} Sentry request owner must report bounded SDK response diagnostics`
  );
  assertConditions(
    [
      identifierName(report.callee) === 'reportTelemetryFailure',
      report.arguments.length === 2,
      literalString(report.arguments[0]) === 'sentry.cloudflare.request_stream',
      identifierName(report.arguments[1]) === 'failure',
    ],
    `${chunkFile} Sentry request owner must report bounded SDK response diagnostics`
  );
};

const assertCloudflareSentryCompletionRegistration = (
  registration,
  chunkFile
) => {
  assert(
    nodeType(registration) === 'ExpressionStatement',
    `${chunkFile} Sentry request owner must register its SDK response completion`
  );
  const register = registration.expression;
  assert(
    nodeType(register) === 'CallExpression',
    `${chunkFile} Sentry request owner must register its SDK response completion`
  );
  assertConditions(
    [
      identifierName(register.callee) === 'registerRequestCompletion',
      register.arguments.length === 2,
      identifierName(register.arguments[0]) === 'request',
      identifierName(register.arguments[1]) === 'sentryCompletion',
    ],
    `${chunkFile} Sentry request owner must register its SDK response completion`
  );
};

const assertCloudflareSentryStreamCompletion = (statement, chunkFile) => {
  const { completionDeclarator, registration } =
    cloudflareSentryCompletionOwner(statement, chunkFile);
  const { catchCall, thenCall } = cloudflareSentryDrainCalls(
    completionDeclarator,
    chunkFile
  );
  assertCloudflareSentryDrainSettle(thenCall.arguments[0], chunkFile);
  assertCloudflareSentryDrainIsolation(catchCall.arguments[0], chunkFile);
  assertCloudflareSentryCompletionRegistration(registration, chunkFile);
};

const assertCloudflareSentryScopeExecution = (
  requestScope,
  withScope,
  wrapRequest,
  chunkFile
) => {
  const statements = requestScope.block.body;
  assert(
    statements.length === 2,
    `${chunkFile} Sentry request owner must execute one bounded SDK request scope`
  );
  const [entry, completion] = statements;
  assert(
    nodeType(entry) === 'VariableDeclaration',
    `${chunkFile} Sentry request owner must own one SDK response`
  );
  assertConditions(
    [
      entry.kind === 'const',
      entry.declarations.length === 1,
      identifierName(entry.declarations[0].id) === 'sentryResponse',
    ],
    `${chunkFile} Sentry request owner must own one SDK response`
  );
  const directAwait = entry.declarations[0].init;
  assertConditions(
    [
      nodeType(directAwait) === 'AwaitExpression',
      nodeType(withScope) === 'CallExpression',
    ],
    `${chunkFile} Sentry request owner must enter SDK isolation directly`
  );
  assertConditions(
    [
      directAwait.argument === withScope,
      identifierMemberSignature(withScope.callee) ===
        'MemberExpression:false:api:withScope',
      withScope.arguments.length === 1,
    ],
    `${chunkFile} Sentry request owner must enter SDK isolation directly`
  );
  assertCloudflareSentryStreamCompletion(completion, chunkFile);
  const scopeCallback = withScope.arguments[0];
  assertConditions(
    [
      nodeType(scopeCallback) === 'ArrowFunctionExpression',
      nodeType(wrapRequest) === 'CallExpression',
    ],
    `${chunkFile} Sentry request owner must wrap the request inside isolation scope`
  );
  assertConditions(
    [
      !scopeCallback.async,
      scopeCallback.params.length === 0,
      scopeCallback.expression,
      scopeCallback.body === wrapRequest,
      identifierMemberSignature(wrapRequest.callee) ===
        'MemberExpression:false:api:wrapRequestHandler',
      wrapRequest.arguments.length === 2,
    ],
    `${chunkFile} Sentry request owner must wrap the request inside isolation scope`
  );
  assertCloudflareSentryRequestOptions(wrapRequest.arguments[0], chunkFile);
};

const assertCloudflareSentryTail = (
  statements,
  requestScopeIndex,
  fallbackExecution,
  chunkFile
) => {
  assert(
    statements.length === requestScopeIndex + 7,
    `${chunkFile} Sentry request owner must have one bounded post-SDK path`
  );
  const tail = statements.slice(requestScopeIndex + 1);
  assertApplicationOutcomeGuard(
    tail[0],
    {
      consequentType: 'ReturnStatement',
      memberName: 'response',
      optional: true,
      outcomeType: 'responded',
    },
    chunkFile
  );
  assertApplicationOutcomeGuard(
    tail[1],
    {
      consequentType: 'ThrowStatement',
      memberName: 'failure',
      optional: true,
      outcomeType: 'failed',
    },
    chunkFile
  );
  assertCloudflareSentrySkippedReport(tail[2], chunkFile);
  assert(
    tail[3]?.expression === fallbackExecution,
    `${chunkFile} Sentry request owner must run one direct fallback execution`
  );
  assertApplicationOutcomeGuard(
    tail[4],
    {
      consequentType: 'ThrowStatement',
      memberName: 'failure',
      optional: false,
      outcomeType: 'failed',
    },
    chunkFile
  );
  assertConditions(
    [
      nodeType(tail[5]) === 'ReturnStatement',
      identifierMemberSignature(tail[5]?.argument) ===
        'MemberExpression:false:applicationOutcome:response',
    ],
    `${chunkFile} Sentry request owner must return the active application response`
  );
};

const assertCloudflareSentryRequestChunkOwner = (program, chunkFile) => {
  const owner = topLevelVariableInitializer(program, 'runWithCloudflareSentry');
  assert(
    nodeType(owner) === 'ArrowFunctionExpression',
    `${chunkFile} Sentry request owner must accept exact active request inputs`
  );
  assertConditions(
    [
      owner.async,
      owner.params.length === 1,
      shorthandBindingSignature({ id: owner.params[0] }) ===
        expectedShorthandBindingSignature([
          'api',
          'handle',
          'request',
          'requestOptions',
        ]),
    ],
    `${chunkFile} Sentry request owner must accept exact active request inputs`
  );
  assert(
    nodeType(owner.body) === 'BlockStatement',
    `${chunkFile} Sentry request owner must own its bounded request body`
  );
  const outcomes = directBodyVariableDeclarators(owner, 'applicationOutcome');
  assert(
    outcomes.length === 1,
    `${chunkFile} Sentry request owner must declare one application outcome`
  );
  assertConditions(
    [
      outcomes[0].index === 0,
      outcomes[0].declaration.kind === 'let',
      outcomes[0].declarator.init === null,
    ],
    `${chunkFile} Sentry request owner must start without a synthetic outcome`
  );
  const work = directBodyVariableDeclarators(owner, 'applicationWork');
  assert(
    work.length === 1,
    `${chunkFile} Sentry request owner must declare one application work slot`
  );
  assertConditions(
    [
      work[0].declaration.kind === 'let',
      work[0].declarator.init === null,
      declaratorsAreExactlySequential(outcomes[0], work[0]),
    ],
    `${chunkFile} Sentry request owner must declare application work after its outcome`
  );
  const runners = directBodyVariableDeclarators(owner, 'runApplicationOnce');
  assert(
    runners.length === 1,
    `${chunkFile} Sentry request owner must define one application execution owner`
  );
  assert(
    runners[0].index === work[0].index + 1,
    `${chunkFile} Sentry request owner must define its runner before request wrapping`
  );
  assertConditions(
    [
      runners[0].declaration.kind === 'const',
      runners[0].declaration.declarations.length === 1,
    ],
    `${chunkFile} Sentry request owner must isolate its application execution owner`
  );
  const runApplicationOnce = runners[0].declarator.init;
  assert(
    nodeType(runApplicationOnce) === 'ArrowFunctionExpression',
    `${chunkFile} Sentry request owner must define one application execution owner`
  );
  assertCloudflareApplicationRunner(runApplicationOnce, chunkFile);
  const requestScopes = owner.body.body
    .map((statement, index) => ({ index, statement }))
    .filter(({ statement }) => statement.type === 'TryStatement');
  assert(
    requestScopes.length === 1 &&
      requestScopes[0].index === runners[0].index + 1,
    `${chunkFile} Sentry request owner must directly enter one SDK request scope`
  );
  const requestScope = requestScopes[0].statement;
  assert(
    nodeType(requestScope) === 'TryStatement',
    `${chunkFile} Sentry request owner must directly enter one SDK request scope`
  );
  assert(
    requestScope.block.body.length > 0,
    `${chunkFile} Sentry request owner must execute its SDK request scope`
  );
  assertCloudflareSentryRequestFailure(requestScope, chunkFile);
  const withScope = memberCallsAnywhere(
    owner,
    'MemberExpression:false:api:withScope'
  );
  const wrapRequest = memberCallsAnywhere(
    owner,
    'MemberExpression:false:api:wrapRequestHandler'
  );
  assertConditions(
    [withScope.length === 1, wrapRequest.length === 1],
    `${chunkFile} Sentry request owner must use one SDK isolation and request wrapper`
  );
  assertCloudflareSentryScopeExecution(
    requestScope,
    withScope[0],
    wrapRequest[0],
    chunkFile
  );
  const requestHandler = wrapRequest[0].arguments[1];
  assertCloudflareSentryRequestHandler(requestHandler, chunkFile);
  assert(
    namedCallsAnywhere(requestHandler, 'runApplicationOnce').length === 1,
    `${chunkFile} Sentry request wrapper must own the application execution`
  );
  const fallbackExecutions = directAssignments(owner, 'applicationOutcome');
  assert(
    fallbackExecutions.length === 1,
    `${chunkFile} Sentry request owner must have one direct fallback execution`
  );
  const fallbackExecution = fallbackExecutions[0];
  assert(
    nodeType(fallbackExecution.right) === 'AwaitExpression',
    `${chunkFile} Sentry request owner must use its application runner for fallback execution`
  );
  assertCloudflareSentryTail(
    owner.body.body,
    requestScopes[0].index,
    fallbackExecution,
    chunkFile
  );
  const fallbackCall = fallbackExecution.right.argument;
  assert(
    nodeType(fallbackCall) === 'CallExpression',
    `${chunkFile} Sentry request owner must use its application runner for fallback execution`
  );
  assertConditions(
    [
      identifierName(fallbackCall.callee) === 'runApplicationOnce',
      fallbackCall.arguments.length === 0,
    ],
    `${chunkFile} Sentry request owner must use its application runner for fallback execution`
  );
  const [lastStatement = {}] = owner.body.body.slice(-1);
  assertConditions(
    [
      lastStatement.type === 'ReturnStatement',
      identifierMemberSignature(lastStatement.argument) ===
        'MemberExpression:false:applicationOutcome:response',
    ],
    `${chunkFile} Sentry request owner must return the active application response`
  );
};

const assertCloudflareApplicationRunner = (runner, chunkFile) => {
  assert(
    nodeType(runner.body) === 'BlockStatement',
    `${chunkFile} Sentry request runner must own one parameterless execution body`
  );
  assert(
    runner.params.length === 0,
    `${chunkFile} Sentry request runner must own one parameterless execution body`
  );
  assert(
    runner.body.body.length === 2,
    `${chunkFile} Sentry request runner must own one memoized application execution`
  );
  const memoizeStatement = runner.body.body[0];
  assert(
    nodeType(memoizeStatement) === 'ExpressionStatement',
    `${chunkFile} Sentry request runner must memoize one application execution`
  );
  const memoize = memoizeStatement.expression;
  assert(
    nodeType(memoize) === 'AssignmentExpression',
    `${chunkFile} Sentry request runner must memoize one application execution`
  );
  assertConditions(
    [
      memoize.operator === '??=',
      identifierName(memoize.left) === 'applicationWork',
    ],
    `${chunkFile} Sentry request runner must memoize one application execution`
  );
  const thenCall = memoize.right;
  assert(
    nodeType(thenCall) === 'CallExpression',
    `${chunkFile} Sentry request runner must schedule one application execution`
  );
  assert(
    nodeType(thenCall.callee) === 'MemberExpression',
    `${chunkFile} Sentry request runner must schedule one application execution`
  );
  assertConditions(
    [
      thenCall.callee.computed === false,
      identifierName(thenCall.callee.property) === 'then',
      thenCall.arguments.length === 1,
    ],
    `${chunkFile} Sentry request runner must schedule one application execution`
  );
  const promiseOwner = thenCall.callee.object;
  assert(
    nodeType(promiseOwner) === 'CallExpression',
    `${chunkFile} Sentry request runner must use the trusted Promise owner`
  );
  assertConditions(
    [
      identifierMemberSignature(promiseOwner.callee) ===
        'MemberExpression:false:Promise:resolve',
      promiseOwner.arguments.length === 0,
    ],
    `${chunkFile} Sentry request runner must use zero-argument Promise.resolve`
  );
  const executeApplication = thenCall.arguments[0];
  assert(
    nodeType(executeApplication) === 'ArrowFunctionExpression',
    `${chunkFile} Sentry request runner must own its bounded async execution body`
  );
  assert(
    nodeType(executeApplication.body) === 'BlockStatement',
    `${chunkFile} Sentry request runner must own its bounded async execution body`
  );
  assertConditions(
    [
      executeApplication.async,
      executeApplication.params.length === 0,
      executeApplication.body.body.length === 1,
      nodeType(executeApplication.body.body[0]) === 'TryStatement',
    ],
    `${chunkFile} Sentry request runner must isolate one async application execution`
  );
  const executionScope = executeApplication.body.body[0];
  assert(
    executionScope.finalizer === null,
    `${chunkFile} Sentry request runner must return one application outcome`
  );
  assert(
    executionScope.block.body.length === 1,
    `${chunkFile} Sentry request runner must return one application outcome`
  );
  const outcomeReturn = executionScope.block.body[0];
  assert(
    nodeType(outcomeReturn) === 'ReturnStatement',
    `${chunkFile} Sentry request runner must return one application outcome`
  );
  const outcome = ownerProperties(
    outcomeReturn.argument,
    chunkFile,
    'the Sentry application execution outcome'
  );
  assert(
    outcome.size === 2,
    `${chunkFile} Sentry request runner must return exact application state`
  );
  const response = outcome.get('response');
  assert(
    nodeType(response) === 'AwaitExpression',
    `${chunkFile} Sentry request runner must await the active application handler`
  );
  assert(
    nodeType(response.argument) === 'CallExpression',
    `${chunkFile} Sentry request runner must return the active application response`
  );
  assertConditions(
    [
      identifierName(response.argument.callee) === 'handle',
      response.argument.arguments.length === 0,
      literalString(outcome.get('type')) === 'responded',
    ],
    `${chunkFile} Sentry request runner must return the active application response`
  );
  const failureHandler = executionScope.handler;
  assert(
    nodeType(failureHandler) === 'CatchClause',
    `${chunkFile} Sentry request runner must preserve application failures`
  );
  assertConditions(
    [
      identifierName(failureHandler.param) === 'failure',
      failureHandler.body.body.length === 1,
    ],
    `${chunkFile} Sentry request runner must preserve application failures`
  );
  const failureReturn = failureHandler.body.body[0];
  assert(
    nodeType(failureReturn) === 'ReturnStatement',
    `${chunkFile} Sentry request runner must return one failed outcome`
  );
  const failedOutcome = ownerProperties(
    failureReturn.argument,
    chunkFile,
    'the Sentry application failure outcome'
  );
  assertConditions(
    [
      failedOutcome.size === 2,
      identifierName(failedOutcome.get('failure')) === 'failure',
      literalString(failedOutcome.get('type')) === 'failed',
    ],
    `${chunkFile} Sentry request runner must return the active application failure`
  );
  const runnerReturn = runner.body.body[1];
  assertConditions(
    [
      nodeType(runnerReturn) === 'ReturnStatement',
      identifierName(runnerReturn.argument) === 'applicationWork',
    ],
    `${chunkFile} Sentry request runner must return its memoized execution`
  );
};

const assertCloudflareSentryRequestChunk = (program, chunkFile) => {
  assertCloudflareIsolationInitializer(program, chunkFile);
  assertCloudflareSentryApplicationChunkOwner(program, chunkFile);
  assertCloudflareSentryRequestChunkOwner(program, chunkFile);
  assertExactStaticChunkHelper(
    program,
    chunkFile,
    'reportTelemetryFailure',
    /^\.\/telemetry(?:-[\w-]+)?\.js$/
  );
  for (const helper of [
    'registerRequestCompletion',
    'snapshotRequestCompletions',
  ]) {
    assertExactStaticChunkHelper(
      program,
      chunkFile,
      helper,
      /^\.\/request-completion(?:-[\w-]+)?\.js$/
    );
    assert(
      identifierOccurrenceCount(program, helper) === 2,
      `${chunkFile} must not alias trusted helper ${helper}`
    );
  }
  assertCloudflareSentrySentinelHelper(program, chunkFile);
  assertCloudflareSentryLifecycleRequestHelper(program, chunkFile);
  assertTrustedChunkBuiltIns(program, chunkFile, {
    Error: 1,
    Promise: 2,
    ReadableStream: 1,
    Request: 1,
    Response: 1,
  });
};

const assertCloudflareRuntimeOwnerImports = (
  program,
  fetchFunction,
  filePath,
  tanStackOwnerDigests
) => {
  const telemetryEntryImport = assertExactEntryDynamicImport(
    program,
    filePath,
    ['createNoOpTelemetry', 'reportTelemetryFailure'],
    /^\.\/assets\/telemetry(?:-[\w-]+)?\.js$/
  );
  const telemetryEntryChunk = path.resolve(
    path.dirname(filePath),
    telemetryEntryImport.importSource
  );
  const {
    manifestRecord: telemetryEntryManifestRecord,
    program: telemetryEntryProgram,
  } = assertCloudflareChunkProvenance(
    filePath,
    telemetryEntryChunk,
    'src/platform/telemetry/index.ts',
    'telemetry entry'
  );
  for (const helper of ['createNoOpTelemetry', 'reportTelemetryFailure']) {
    assertExactStaticChunkHelper(
      telemetryEntryProgram,
      telemetryEntryChunk,
      helper,
      /^\.\/telemetry(?:-[\w-]+)?\.js$/
    );
    const helperExports = telemetryEntryProgram.body
      .flatMap(namedExportEntries)
      .filter(([exportedName]) => exportedName === helper);
    assert(
      helperExports.length === 1 && helperExports[0][1] === helper,
      `${telemetryEntryChunk} must re-export trusted helper ${helper} directly`
    );
    assert(
      !mutatedNames(telemetryEntryProgram).has(helper),
      `${telemetryEntryChunk} must not mutate trusted helper ${helper}`
    );
  }
  assertExactCloudflareStaticImportSources(
    telemetryEntryProgram,
    telemetryEntryChunk,
    [
      /^\.\/tags(?:-[\w-]+)?\.js$/,
      /^\.\/telemetry(?:-[\w-]+)?\.js$/,
      /^\.\/request-completion(?:-[\w-]+)?\.js$/,
      /^\.\/request-exception-state(?:-[\w-]+)?\.js$/,
      /^\.\/structured-console(?:-[\w-]+)?\.js$/,
    ]
  );
  assertBoundedCloudflareChunkTopLevel(
    telemetryEntryProgram,
    telemetryEntryChunk,
    telemetryEntryManifestRecord
  );
  const telemetryAdapterImport = assertExactEntryDynamicImport(
    program,
    filePath,
    ['createCloudflareTelemetryAdapter'],
    /^\.\/assets\/telemetry-adapter(?:-[\w-]+)?\.js$/
  );
  const telemetryAdapterChunk = path.resolve(
    path.dirname(filePath),
    telemetryAdapterImport.importSource
  );
  const {
    manifestRecord: telemetryAdapterManifestRecord,
    program: telemetryAdapterProgram,
  } = assertCloudflareChunkProvenance(
    filePath,
    telemetryAdapterChunk,
    'src/runtime/cloudflare/telemetry-adapter.ts',
    'native telemetry adapter'
  );
  assertCloudflareChunkLocalOwner(
    telemetryAdapterProgram,
    telemetryAdapterChunk,
    'createCloudflareTelemetryAdapter'
  );
  assertExactCloudflareStaticImportSources(
    telemetryAdapterProgram,
    telemetryAdapterChunk,
    [
      /^\.\/telemetry(?:-[\w-]+)?\.js$/,
      /^\.\/structured-console(?:-[\w-]+)?\.js$/,
    ]
  );
  assertBoundedCloudflareChunkTopLevel(
    telemetryAdapterProgram,
    telemetryAdapterChunk,
    telemetryAdapterManifestRecord
  );
  assertExactEntryDynamicImport(
    program,
    filePath,
    ['tracing'],
    /^cloudflare:workers$/
  );
  const applicationDeclarator = assertCloudflareApplicationOwner(
    program,
    filePath,
    tanStackOwnerDigests
  );
  const sdkDeclarator = assertCloudflareSdkOwner(program, filePath);
  const sentryOwners = [
    'initializeCloudflareSentryApplication',
    'runWithCloudflareSentry',
  ];
  const sentryImport = assertCloudflareNamedOwnerImport(program, filePath, {
    assetPattern: /^\.\/assets\/sentry-request(?:-[\w-]+)?\.js$/,
    exportedNames: sentryOwners,
    requiredCalls: {
      initializeCloudflareSentryApplication: [
        'initializeCloudflareSentryIsolation',
      ],
    },
    requiredIdentifiers: {
      runWithCloudflareSentry: ['withScope', 'wrapRequestHandler'],
    },
  });
  assertCloudflareChunkProvenance(
    filePath,
    sentryImport.chunkFile,
    'src/runtime/cloudflare/sentry-request.ts',
    'Sentry request owner'
  );
  assertCloudflareSentryRequestChunk(
    sentryImport.program,
    sentryImport.chunkFile
  );
  assertExactCloudflareStaticImportSources(
    sentryImport.program,
    sentryImport.chunkFile,
    [
      /^\.\/telemetry(?:-[\w-]+)?\.js$/,
      /^\.\/request-completion(?:-[\w-]+)?\.js$/,
    ]
  );
  assertBoundedCloudflareChunkTopLevel(
    sentryImport.program,
    sentryImport.chunkFile,
    sentryImport.manifestRecord
  );
  const databaseOwner = 'runWithCloudflareDatabase';
  const databaseImport = assertCloudflareNamedOwnerImport(program, filePath, {
    assetPattern: /^\.\/assets\/database-request(?:-[\w-]+)?\.js$/,
    exportedNames: [databaseOwner],
    requiredCalls: {
      [databaseOwner]: [
        'createHyperdriveDbClient',
        'runWithRuntimeDatabaseClient',
      ],
    },
    requiredIdentifiers: {
      [databaseOwner]: ['validateServerConfig'],
    },
  });
  assertCloudflareChunkProvenance(
    filePath,
    databaseImport.chunkFile,
    'src/runtime/cloudflare/database-request.ts',
    'database request owner'
  );
  assertCloudflareDatabaseChunk(
    databaseImport.program,
    databaseImport.chunkFile
  );
  assertExactCloudflareStaticImportSources(
    databaseImport.program,
    databaseImport.chunkFile,
    [
      /^\.\/client(?:-[\w-]+)?\.js$/,
      /^\.\/backend(?:-[\w-]+)?\.js$/,
      /^\.\/telemetry(?:-[\w-]+)?\.js$/,
    ]
  );
  assertBoundedCloudflareChunkTopLevel(
    databaseImport.program,
    databaseImport.chunkFile,
    databaseImport.manifestRecord
  );
  const lifecycleOwner = 'scheduleCloudflareRequestFlush';
  const lifecycleImport = assertCloudflareNamedOwnerImport(program, filePath, {
    assetPattern: /^\.\/assets\/request-lifecycle(?:-[\w-]+)?\.js$/,
    exportedNames: [lifecycleOwner],
    requiredCalls: {
      [lifecycleOwner]: ['forceFlushRequestTelemetry', 'getTelemetry'],
    },
  });
  assertCloudflareChunkProvenance(
    filePath,
    lifecycleImport.chunkFile,
    'src/runtime/cloudflare/request-lifecycle.ts',
    'request lifecycle owner'
  );
  assertCloudflareLifecycleChunk(
    lifecycleImport.program,
    lifecycleImport.chunkFile
  );
  assertExactCloudflareStaticImportSources(
    lifecycleImport.program,
    lifecycleImport.chunkFile,
    [
      /^\.\/telemetry(?:-[\w-]+)?\.js$/,
      /^\.\/request-completion(?:-[\w-]+)?\.js$/,
    ]
  );
  assertBoundedCloudflareChunkTopLevel(
    lifecycleImport.program,
    lifecycleImport.chunkFile,
    lifecycleImport.manifestRecord
  );
  const fetchOwnerDeclarator = topLevelBindingDeclarators(
    program,
    'fetchCloudflareApplication'
  )[0];
  const configuratorDeclarator = topLevelBindingDeclarators(
    program,
    'configureCloudflareRequestTelemetry'
  )[0];
  const ownerOrder = [
    sdkDeclarator,
    sentryImport.declarator,
    applicationDeclarator,
    databaseImport.declarator,
    configuratorDeclarator,
    lifecycleImport.declarator,
    fetchOwnerDeclarator,
  ].map((declarator) => topLevelDeclaratorStatementIndex(program, declarator));
  assert(
    ownerOrder.every((index, position) =>
      position === 0 ? index >= 0 : ownerOrder[position - 1] < index
    ),
    `${filePath} must initialize Cloudflare runtime owners in dependency order`
  );
  const fetchRange = [[fetchFunction.start, fetchFunction.end]];
  const applicationRange = [
    [applicationDeclarator.init.start, applicationDeclarator.init.end],
  ];
  const sentryOwnerRange = [
    [fetchOwnerDeclarator.init.start, fetchOwnerDeclarator.init.end],
  ];
  assertOwnerReferencesStayInRanges(
    program,
    filePath,
    'Sentry',
    sdkDeclarator,
    [...applicationRange, ...sentryOwnerRange, ...fetchRange]
  );
  assertOwnerReferencesStayInRanges(
    program,
    filePath,
    sentryOwners[0],
    sentryImport.declarator,
    applicationRange
  );
  assertOwnerReferencesStayInRanges(
    program,
    filePath,
    sentryOwners[1],
    sentryImport.declarator,
    sentryOwnerRange
  );
  assertOwnerReferencesStayInRanges(
    program,
    filePath,
    databaseOwner,
    databaseImport.declarator,
    fetchRange
  );
  assertOwnerReferencesStayInRanges(
    program,
    filePath,
    lifecycleOwner,
    lifecycleImport.declarator,
    fetchRange
  );
};

const assertExactEntryDynamicImport = (
  program,
  filePath,
  ownerNames,
  sourcePattern
) => {
  const declarator = assertSharedTopLevelBindingDeclarator(
    program,
    ownerNames,
    (owner) => `${filePath} must import trusted owner ${owner} exactly once`,
    `${filePath} must import trusted owners ${ownerNames.join(', ')} together`
  );
  assert(
    shorthandBindingSignature(declarator) ===
      expectedShorthandBindingSignature(ownerNames),
    `${filePath} must import trusted owner ${ownerNames[0]} by exact shorthand`
  );
  assert(
    nodeType(declarator.init) === 'AwaitExpression',
    `${filePath} must await trusted owner ${ownerNames[0]} import`
  );
  assert(
    sourcePattern.test(dynamicImportSource(declarator) ?? ''),
    `${filePath} must import trusted owner ${ownerNames[0]} from its owner module`
  );
  const mutations = mutatedNames(program);
  for (const owner of ownerNames) {
    assert(
      !mutations.has(owner),
      `${filePath} must not mutate trusted owner ${owner}`
    );
  }
  return { declarator, importSource: dynamicImportSource(declarator) };
};

const assertNoProgramCloudflareOwnerAliases = (
  program,
  fetchFunction,
  filePath
) => {
  const trustedOwners = Object.keys(trustedOwnerBindingValidators);
  for (const owner of trustedOwners) {
    const declarators = topLevelBindingDeclarators(program, owner);
    assert(
      declarators.length <= 1,
      `${filePath} must declare trusted owner ${owner} at most once`
    );
    const allowedRanges = [[fetchFunction.start, fetchFunction.end]];
    const [declarator] = declarators;
    if (declarator) {
      assert(
        trustedOwnerBindingValidators[owner](declarator),
        `${filePath} must initialize trusted owner ${owner} from its runtime owner`
      );
      allowedRanges.push([declarator.id.start, declarator.id.end]);
    }
    assert(
      !hasIdentifierOutsideRanges(program, owner, allowedRanges),
      `${filePath} must not alias trusted owner ${owner}`
    );
  }
  assertCloudflareRequestTelemetryOwner(program, fetchFunction, filePath);
};

const ownerProperties = (node, filePath, label) => {
  assert(
    node?.type === 'ObjectExpression',
    `${filePath} must configure ${label}`
  );
  assert(
    node.properties.every((property) => property.type === 'Property'),
    `${filePath} ${label} must not contain spread properties`
  );
  assert(
    node.properties.every((property) => !property.computed),
    `${filePath} ${label} must use static property keys`
  );
  const entries = node.properties.map((property) => [
    propertyKeyName(property),
    property.value,
  ]);
  const names = entries.map(([name]) => name);
  assert(
    names.every((name) => typeof name === 'string'),
    `${filePath} ${label} must use static property names`
  );
  assert(
    new Set(names).size === names.length,
    `${filePath} ${label} must not contain duplicate properties`
  );
  return new Map(entries);
};

const assertCloudflareSentryCallOptions = (options, filePath) => {
  const properties = ownerProperties(
    options,
    filePath,
    'the Cloudflare Sentry request owner'
  );
  assert(
    identifierName(properties.get('api')) === 'Sentry',
    `${filePath} Cloudflare Sentry owner must use the initialized Sentry API`
  );
  assert(
    identifierName(properties.get('handle')) === 'handle',
    `${filePath} Cloudflare Sentry owner must invoke its active handler`
  );
  assert(
    identifierName(properties.get('request')) === 'request',
    `${filePath} Cloudflare Sentry owner must receive the active request`
  );
  const requestOptions = ownerProperties(
    properties.get('requestOptions'),
    filePath,
    'the Cloudflare Sentry request context'
  );
  assert(
    requestOptions.get('captureErrors')?.value === false,
    `${filePath} Cloudflare Sentry owner must leave error capture to the application boundary`
  );
  assert(
    identifierName(requestOptions.get('context')) === 'context',
    `${filePath} Cloudflare Sentry owner must preserve the execution context`
  );
  assert(
    identifierName(requestOptions.get('options')) === 'sentryOptions',
    `${filePath} Cloudflare Sentry owner must preserve validated Sentry options`
  );
  assert(
    identifierName(requestOptions.get('request')) === 'request',
    `${filePath} Cloudflare Sentry owner must preserve the active request context`
  );
};

const assertCloudflareSentryOwner = (program, filePath) => {
  const owner = topLevelVariableInitializer(
    program,
    'fetchCloudflareApplication'
  );
  assert(
    owner?.type === 'ArrowFunctionExpression',
    `${filePath} must define its active Cloudflare Sentry request owner`
  );
  assert(
    owner.params.length === 1,
    `${filePath} Cloudflare Sentry owner must accept exactly one request input`
  );
  const [parameters = {}] = owner.params;
  assert(
    parameters.type === 'ObjectPattern',
    `${filePath} Cloudflare Sentry owner must destructure its request inputs`
  );
  assert(
    parameters.properties
      .map(
        (property) =>
          `${propertyKeyName(property)}:${identifierName(property.value)}:${property.shorthand}`
      )
      .join('|') ===
      'context:context:true|handle:handle:true|request:request:true|sentryOptions:sentryOptions:true',
    `${filePath} Cloudflare Sentry owner must accept the active request inputs`
  );
  const choice = owner.body;
  assert(
    choice.type === 'ConditionalExpression',
    `${filePath} Cloudflare Sentry owner must select its request handler`
  );
  assert(
    identifierName(choice.test) === 'sentryOptions',
    `${filePath} Cloudflare Sentry owner must branch on validated Sentry options`
  );
  const sentryCall = unwrapAwaitExpression(choice.consequent);
  assert(
    sentryCall.type === 'CallExpression',
    `${filePath} Cloudflare Sentry owner must call its request wrapper`
  );
  assert(
    identifierName(sentryCall.callee) === 'runWithCloudflareSentry',
    `${filePath} Cloudflare Sentry owner must invoke runWithCloudflareSentry`
  );
  assert(
    sentryCall.arguments.length === 1,
    `${filePath} Cloudflare Sentry owner must invoke runWithCloudflareSentry`
  );
  const [options = {}] = sentryCall.arguments;
  assertCloudflareSentryCallOptions(options, filePath);
  const fallback = unwrapAwaitExpression(choice.alternate);
  assert(
    fallback.type === 'CallExpression',
    `${filePath} Cloudflare Sentry owner must call its disabled fallback`
  );
  assert(
    identifierName(fallback.callee) === 'handle' &&
      fallback.arguments.length === 0,
    `${filePath} Cloudflare Sentry owner must preserve its disabled fallback`
  );
};

const assertCloudflareApplicationHandler = (fetchFunction, filePath) => {
  assert(
    directVariableDeclarators(fetchFunction, 'handleApplication').length === 1,
    `${filePath} Worker fetch must declare its application handler exactly once`
  );
  const handleApplication = directVariableInitializer(
    fetchFunction,
    'handleApplication'
  );
  assert(
    handleApplication?.type === 'ArrowFunctionExpression',
    `${filePath} Worker fetch must define its active application handler`
  );
  assert(
    handleApplication.params.length === 0,
    `${filePath} active application handler must accept no substitutable inputs`
  );
  const applicationCall = unwrapAwaitExpression(handleApplication.body);
  assert(
    applicationCall?.type === 'CallExpression',
    `${filePath} active application handler must return its application response`
  );
  assert(
    identifierMemberSignature(applicationCall.callee) ===
      'MemberExpression:false:application:fetch',
    `${filePath} active application handler must invoke application.fetch`
  );
  assert(
    applicationCall.arguments.length === 2,
    `${filePath} active application handler must invoke application.fetch with the active request`
  );
  assert(
    identifierName(applicationCall.arguments[0]) === 'request',
    `${filePath} active application handler must invoke application.fetch with the active request`
  );
  const applicationOptions = ownerProperties(
    applicationCall.arguments[1],
    filePath,
    'the active application request options'
  );
  const applicationContext = applicationOptions.get('context');
  assertConditions(
    [
      applicationOptions.size === 1,
      nodeType(applicationContext) === 'UnaryExpression',
      applicationContext.operator === 'void',
      applicationContext.argument?.value === 0,
    ],
    `${filePath} active application handler must preserve its exact request options`
  );
};

const cloudflareDatabaseOwnerProperties = (fetchFunction, filePath) => {
  assert(
    directVariableDeclarators(fetchFunction, 'handleDatabase').length === 1,
    `${filePath} Worker fetch must declare its database handler exactly once`
  );
  const handleDatabase = directVariableInitializer(
    fetchFunction,
    'handleDatabase'
  );
  assert(
    handleDatabase?.type === 'ArrowFunctionExpression',
    `${filePath} Worker fetch must define its active database handler`
  );
  assert(
    handleDatabase.params.length === 0,
    `${filePath} active database handler must accept no substitutable inputs`
  );
  const calls = directNamedCalls(handleDatabase, 'runWithCloudflareDatabase');
  assert(
    calls.length === 1,
    `${filePath} must contain exactly one Cloudflare database request owner`
  );
  const [call] = calls;
  assert(
    nodeRangeSignature(handleDatabase.body) === nodeRangeSignature(call),
    `${filePath} active database handler must return its database-owned response`
  );
  assert(
    call.arguments.length === 1,
    `${filePath} active database handler must return its database-owned response`
  );
  const [options = {}] = call.arguments;
  return ownerProperties(options, filePath, 'the Cloudflare database owner');
};

const assertCloudflareWaitUntilOwner = (waitUntil, filePath) => {
  assert(
    waitUntil?.type === 'ArrowFunctionExpression',
    `${filePath} Worker telemetry flush must own one completion callback`
  );
  assert(
    waitUntil.params.map(identifierName).join(':') === 'completion',
    `${filePath} Worker telemetry flush must own one completion callback`
  );
  const waitUntilCall = unwrapAwaitExpression(waitUntil.body);
  assert(
    waitUntilCall?.type === 'CallExpression',
    `${filePath} Worker telemetry flush must use the active execution context`
  );
  assert(
    identifierMemberSignature(waitUntilCall.callee) ===
      'MemberExpression:false:context:waitUntil',
    `${filePath} Worker telemetry flush must use the active execution context`
  );
  assert(
    waitUntilCall.arguments.length === 1,
    `${filePath} Worker telemetry flush must schedule the active completion`
  );
  assert(
    identifierName(waitUntilCall.arguments[0]) === 'completion',
    `${filePath} Worker telemetry flush must schedule the active completion`
  );
};

const assertCloudflareFlushCall = (flushStatement, filePath) => {
  const flushCall = flushStatement.expression;
  assert(
    flushStatement.type === 'ExpressionStatement',
    `${filePath} Worker request owner must schedule its Cloudflare telemetry flush`
  );
  assert(
    flushCall?.type === 'CallExpression',
    `${filePath} Worker request owner must schedule its Cloudflare telemetry flush`
  );
  assert(
    identifierName(flushCall.callee) === 'scheduleCloudflareRequestFlush',
    `${filePath} Worker request owner must schedule its Cloudflare telemetry flush`
  );
  assert(
    flushCall.arguments.length === 2,
    `${filePath} Worker telemetry flush must receive the active request`
  );
  assert(
    identifierName(flushCall.arguments[0]) === 'request',
    `${filePath} Worker telemetry flush must receive the active request`
  );
  assertCloudflareWaitUntilOwner(flushCall.arguments[1], filePath);
};

const assertCloudflareRequestFlush = (tryStatement, filePath) => {
  assert(
    tryStatement.handler === null,
    `${filePath} Worker request owner must not intercept application failures`
  );
  assert(
    tryStatement.finalizer?.body.length === 1,
    `${filePath} Worker request owner must schedule exactly one telemetry flush`
  );
  const [flushStatement = {}] = tryStatement.finalizer.body;
  assertCloudflareFlushCall(flushStatement, filePath);
};

const cloudflareOuterOwnerProperties = (fetchFunction, filePath) => {
  const returns = directReturnStatements(fetchFunction);
  assert(
    returns.length === 1,
    `${filePath} Worker fetch must have exactly one Sentry-owned return path`
  );
  const [finalStatement = {}] = fetchFunction.body.body.slice(-1);
  assert(
    finalStatement.type === 'TryStatement',
    `${filePath} Worker fetch must return through its top-level Sentry ownership scope`
  );
  assertCloudflareRequestFlush(finalStatement, filePath);
  assert(
    finalStatement.block.body.length === 1,
    `${filePath} Worker Sentry ownership scope must contain one return`
  );
  const [ownerReturn = {}] = finalStatement.block.body;
  assert(
    ownerReturn.type === 'ReturnStatement',
    `${filePath} Worker Sentry ownership scope must return its response`
  );
  assert(
    nodeType(ownerReturn.argument) === 'AwaitExpression',
    `${filePath} Worker fetch must await its Sentry-owned response before flushing`
  );
  const sentryCall = ownerReturn.argument.argument;
  assert(
    nodeType(sentryCall) === 'CallExpression',
    `${filePath} Worker fetch must return or await its Sentry-owned response`
  );
  assert(
    identifierName(sentryCall.callee) === 'fetchCloudflareApplication',
    `${filePath} Worker fetch must return or await its Sentry-owned response`
  );
  assert(
    sentryCall.arguments.length === 1,
    `${filePath} Worker fetch must return or await its Sentry-owned response`
  );
  const [sentryOptions = {}] = sentryCall.arguments;
  return ownerProperties(
    sentryOptions,
    filePath,
    'the active Cloudflare Sentry request owner'
  );
};

const assertCloudflareFetchStatementSequence = (fetchFunction, filePath) => {
  const statements = fetchFunction.body.body;
  const owners = [
    directBodyVariableDeclarators(fetchFunction, 'nativeTelemetry')[0],
    directBodyVariableDeclarators(fetchFunction, 'sentryOptions')[0],
    directBodyVariableDeclarators(fetchFunction, 'handleApplication')[0],
    directBodyVariableDeclarators(fetchFunction, 'handleDatabase')[0],
  ];
  assertConditions(
    [
      statements.length === 6,
      owners.map(({ index }) => index).join(':') === '0:2:3:4',
      owners.every(({ declaration }) => declaration.declarations.length === 1),
      nodeType(statements[1]) === 'TryStatement',
      nodeType(statements[5]) === 'TryStatement',
    ],
    `${filePath} Worker fetch must contain only its bounded runtime ownership sequence`
  );
};

const assertCloudflareEntryModuleBoundary = (program, filePath) => {
  assertTrustedChunkBuiltIns(program, filePath, { Response: 0 });
  const expectedStatements = 13;
  assert(
    program.body.length === expectedStatements,
    `${filePath} must contain only its bounded Cloudflare module ownership sequence (expected ${expectedStatements} top-level statements, received ${program.body.length})`
  );
};

const assertCloudflareDatabaseOwner = (filePath, tanStackOwnerDigests) => {
  const { program } = readParsedModule(filePath);
  assertCloudflareSentryOwner(program, filePath);
  const fetchFunction = findDefaultWorkerFetch(program, filePath);
  assert(
    fetchFunction.params.map(identifierName).join(':') ===
      'request:environment:context',
    `${filePath} Worker fetch must expose the active request, environment, and context`
  );
  assertNoCloudflareOwnerOverrides(program, fetchFunction, filePath);
  assertExactCloudflareOwnerUsage(fetchFunction, filePath);
  assertNoProgramCloudflareOwnerAliases(program, fetchFunction, filePath);
  assertCloudflareRuntimeOwnerImports(
    program,
    fetchFunction,
    filePath,
    tanStackOwnerDigests
  );
  assertCloudflareApplicationHandler(fetchFunction, filePath);
  const options = cloudflareDatabaseOwnerProperties(fetchFunction, filePath);
  const sentryOptions = cloudflareOuterOwnerProperties(fetchFunction, filePath);
  assertCloudflareFetchStatementSequence(fetchFunction, filePath);
  assert(
    identifierName(sentryOptions.get('handle')) === 'handleDatabase',
    `${filePath} Sentry request owner must invoke the active database handler`
  );
  assert(
    identifierName(sentryOptions.get('request')) === 'request',
    `${filePath} Sentry request owner must receive the active request`
  );
  assert(
    identifierName(sentryOptions.get('context')) === 'context',
    `${filePath} Sentry request owner must receive the active execution context`
  );
  assert(
    identifierName(sentryOptions.get('sentryOptions')) === 'sentryOptions',
    `${filePath} Sentry request owner must receive the validated Sentry options`
  );
  assert(
    identifierMemberSignature(options.get('binding')) ===
      'MemberExpression:false:environment:START_UI_DATABASE',
    `${filePath} must bind the Cloudflare database owner to environment.START_UI_DATABASE`
  );
  assert(
    identifierName(options.get('handle')) === 'handleApplication',
    `${filePath} must bind the Cloudflare database owner to the active application handler`
  );
  assert(
    identifierName(options.get('request')) === 'request',
    `${filePath} must bind the Cloudflare database owner to the active request`
  );
  assertCloudflareEntryModuleBoundary(program, filePath);
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

const staticImportSpecifierDetails = {
  ImportDefaultSpecifier: () => ({
    importedName: 'default',
    importKind: 'default',
  }),
  ImportNamespaceSpecifier: () => ({
    importedName: '*',
    importKind: 'namespace',
  }),
  ImportSpecifier: (specifier) => ({
    importedName: identifierName(specifier.imported),
    importKind: 'named',
  }),
};

const staticImportForBinding = (statement, localName) => {
  if (statement.type !== 'ImportDeclaration') return undefined;
  const specifier = statement.specifiers.find(
    (candidate) => identifierName(candidate.local) === localName
  );
  const readDetails = staticImportSpecifierDetails[specifier?.type];
  if (!readDetails) return undefined;
  return {
    ...readDetails(specifier),
    localName,
    source: literalString(statement.source),
  };
};

const findStaticImport = (program, localName) =>
  program.body
    .map((statement) => staticImportForBinding(statement, localName))
    .find(Boolean);

const staticImportsByLocalName = (program) =>
  new Map(
    program.body
      .filter((statement) => statement.type === 'ImportDeclaration')
      .flatMap((statement) =>
        statement.specifiers.flatMap((specifier) => {
          const localName = identifierName(specifier.local);
          const readDetails = staticImportSpecifierDetails[specifier.type];
          return localName && readDetails
            ? [
                [
                  localName,
                  {
                    ...readDetails(specifier),
                    localName,
                    source: literalString(statement.source),
                  },
                ],
              ]
            : [];
        })
      )
  );

const staticImportsForBinding = (program, localName) =>
  program.body
    .map((statement) => staticImportForBinding(statement, localName))
    .filter(Boolean);

const hasSingleFunctionBinding = (owners, bindings) =>
  owners.length === 1 && bindings.length === 1 && owners[0][1] === bindings[0];

const assertExactStaticChunkHelper = (
  program,
  chunkFile,
  localName,
  sourcePattern
) => {
  const imports = staticImportsForBinding(program, localName);
  assert(
    imports.length === 1,
    `${chunkFile} must import trusted helper ${localName} exactly once`
  );
  assert(
    sourcePattern.test(imports[0].source ?? ''),
    `${chunkFile} must import trusted helper ${localName} from its owner chunk`
  );
  const helperChunk = path.resolve(path.dirname(chunkFile), imports[0].source);
  assert(
    isWithinDirectory(helperChunk, path.dirname(chunkFile)),
    `${chunkFile} must keep trusted helper ${localName} inside its artifact`
  );
  assertFile(helperChunk);
  const { program: helperProgram } = readParsedModule(helperChunk);
  const artifactRoot = path.dirname(path.dirname(chunkFile));
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    helperChunk,
    `trusted helper ${localName}`
  );
  const helperExports = helperProgram.body
    .filter(
      (statement) =>
        statement.type === 'ExportNamedDeclaration' && !statement.source
    )
    .flatMap(namedExportEntries)
    .filter(([exportedName]) => exportedName === imports[0].importedName);
  assert(
    helperExports.length === 1 && helperExports[0][1] === localName,
    `${chunkFile} must import the ${localName} export from its owner chunk`
  );
  const helperOwners = helperProgram.body
    .flatMap(topLevelFunctionEntries)
    .filter(([name]) => name === localName);
  const helperBindings = topLevelDeclarationsForBinding(
    helperProgram,
    localName
  );
  assert(
    hasSingleFunctionBinding(helperOwners, helperBindings),
    `${helperChunk} must define trusted helper ${localName} exactly once`
  );
  assert(
    !mutatedNames(helperProgram).has(localName),
    `${helperChunk} must not mutate trusted helper ${localName}`
  );
  const localFunctions = program.body
    .flatMap(topLevelFunctionEntries)
    .filter(([name]) => name === localName);
  assert(
    localFunctions.length === 0,
    `${chunkFile} must not substitute trusted helper ${localName}`
  );
  assert(
    topLevelBindingDeclarators(program, localName).length === 0,
    `${chunkFile} must not redeclare trusted helper ${localName}`
  );
  assertBoundedCloudflareHelperChunk(
    helperProgram,
    helperChunk,
    manifestRecord,
    localName
  );
  return { helperChunk, helperProgram, manifestRecord };
};

const assertExactLocalChunkFunction = (program, chunkFile, localName) => {
  const localFunctions = program.body
    .flatMap(topLevelFunctionEntries)
    .filter(([name]) => name === localName);
  const localBindings = topLevelBindingDeclarators(program, localName);
  assert(
    localFunctions.length === 1 &&
      localBindings.length === 1 &&
      localFunctions[0][1] === localBindings[0].init,
    `${chunkFile} must define trusted helper ${localName} exactly once`
  );
  assert(
    staticImportsForBinding(program, localName).length === 0,
    `${chunkFile} must own trusted helper ${localName} locally`
  );
  assert(
    !mutatedNames(program).has(localName),
    `${chunkFile} must not mutate trusted helper ${localName}`
  );
};

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

const variableOwnerEntries = (statement) =>
  statement.declarations.flatMap((declarator) =>
    bindingNames(declarator.id).map((name) => [
      name,
      { kind: statement.kind, node: declarator },
    ])
  );

const declaredOwnerEntries = (statement) =>
  statement.id
    ? [[statement.id.name, { kind: statement.type, node: statement }]]
    : [];
const noOwnerEntries = () => [];
const topLevelOwnerReaders = {
  ClassDeclaration: declaredOwnerEntries,
  FunctionDeclaration: declaredOwnerEntries,
  VariableDeclaration: variableOwnerEntries,
};
const topLevelOwnerEntries = (statement) =>
  (topLevelOwnerReaders[statement.type] ?? noOwnerEntries)(statement);

const addPatternBindingNames = (names, pattern) => {
  bindingNames(pattern).forEach((name) => names.add(name));
};

const lexicalVariableBindingNames = (statement) => {
  if (statement.type !== 'VariableDeclaration') return [];
  if (statement.kind === 'var') return [];
  return statement.declarations.flatMap(({ id }) => bindingNames(id));
};

const lexicalDeclaredBindingNames = (statement) => {
  if (
    !new Set(['ClassDeclaration', 'FunctionDeclaration']).has(statement.type)
  ) {
    return [];
  }
  return statement.id ? [statement.id.name] : [];
};

const blockLexicalBindingNames = (statements) =>
  new Set(
    statements.flatMap((statement) => [
      ...lexicalVariableBindingNames(statement),
      ...lexicalDeclaredBindingNames(statement),
    ])
  );

const functionScopedVarNames = (functionNode) => {
  const names = new Set();
  const nestedRanges = nestedFunctionRanges(functionNode);
  new Visitor({
    VariableDeclaration(declaration) {
      if (
        declaration.kind === 'var' &&
        !isInsideNestedFunction(declaration, nestedRanges)
      ) {
        declaration.declarations.forEach((declarator) =>
          addPatternBindingNames(names, declarator.id)
        );
      }
    },
  }).visit(functionNode);
  return names;
};

const withShadowedNames = (shadowed, names) => {
  if (names.size === 0) return shadowed;
  return new Set([...shadowed, ...names]);
};

const recordFreeIdentifierReference = (
  identifier,
  shadowed,
  { names, nodes }
) => {
  if (shadowed.has(identifier.name)) return;
  names.add(identifier.name);
  nodes.add(identifier);
};

const visitFreeReferencePattern = (pattern, shadowed, state) => {
  if (!pattern) return;
  const reader = freeReferencePatternReaders[pattern.type] ?? noFreeReference;
  reader(pattern, shadowed, state);
};

const visitFreeAssignmentPattern = (pattern, shadowed, state) => {
  visitFreeReferenceNode(pattern.right, shadowed, state);
  visitFreeReferencePattern(pattern.left, shadowed, state);
};

const visitFreeArrayPattern = (pattern, shadowed, state) => {
  pattern.elements.forEach((element) =>
    visitFreeReferencePattern(element, shadowed, state)
  );
};

const visitFreeObjectPatternProperty = (property, shadowed, state) => {
  if (property.type === 'RestElement') {
    visitFreeReferencePattern(property.argument, shadowed, state);
    return;
  }
  if (property.computed) {
    visitFreeReferenceNode(property.key, shadowed, state);
  }
  visitFreeReferencePattern(property.value, shadowed, state);
};

const visitFreeObjectPattern = (pattern, shadowed, state) => {
  pattern.properties.forEach((property) =>
    visitFreeObjectPatternProperty(property, shadowed, state)
  );
};

const visitFreeRestPattern = (pattern, shadowed, state) => {
  visitFreeReferencePattern(pattern.argument, shadowed, state);
};

const noFreeReference = () => {};
const freeReferencePatternReaders = {
  ArrayPattern: visitFreeArrayPattern,
  AssignmentPattern: visitFreeAssignmentPattern,
  ObjectPattern: visitFreeObjectPattern,
  RestElement: visitFreeRestPattern,
};

const freeReferenceFunctionParameterScope = (functionNode, shadowed) => {
  const localNames = new Set();
  functionNode.params.forEach((parameter) =>
    addPatternBindingNames(localNames, parameter)
  );
  if (functionNode.id) localNames.add(functionNode.id.name);
  return withShadowedNames(shadowed, localNames);
};

const visitFreeReferenceFunction = (functionNode, shadowed, state) => {
  const parameterScope = freeReferenceFunctionParameterScope(
    functionNode,
    shadowed
  );
  functionNode.params.forEach((parameter) =>
    visitFreeReferencePattern(parameter, parameterScope, state)
  );
  const bodyScope = withShadowedNames(
    parameterScope,
    functionScopedVarNames(functionNode)
  );
  visitFreeReferenceNode(functionNode.body, bodyScope, state);
};

const visitFreeReferenceBlock = (block, shadowed, state) => {
  const blockScope = withShadowedNames(
    shadowed,
    blockLexicalBindingNames(block.body)
  );
  block.body.forEach((statement) =>
    visitFreeReferenceNode(statement, blockScope, state)
  );
};

const visitFreeReferenceVariableDeclaration = (
  declaration,
  shadowed,
  state
) => {
  declaration.declarations.forEach((declarator) => {
    visitFreeReferencePattern(declarator.id, shadowed, state);
    visitFreeReferenceNode(declarator.init, shadowed, state);
  });
};

const visitFreeReferenceCatch = (clause, shadowed, state) => {
  const catchScope = withShadowedNames(
    shadowed,
    new Set(bindingNames(clause.param))
  );
  visitFreeReferencePattern(clause.param, catchScope, state);
  visitFreeReferenceNode(clause.body, catchScope, state);
};

const loopLexicalBindingNames = (loop) => {
  const declaration = loop.init ?? loop.left;
  if (nodeType(declaration) !== 'VariableDeclaration') return new Set();
  if (declaration.kind === 'var') return new Set();
  return new Set(
    declaration.declarations.flatMap(({ id }) => bindingNames(id))
  );
};

const visitFreeReferenceLoop = (loop, shadowed, state) => {
  const loopScope = withShadowedNames(shadowed, loopLexicalBindingNames(loop));
  visitFreeReferenceNode(loop.init, loopScope, state);
  visitFreeReferenceNode(loop.left, loopScope, state);
  visitFreeReferenceNode(loop.right, loopScope, state);
  visitFreeReferenceNode(loop.test, loopScope, state);
  visitFreeReferenceNode(loop.update, loopScope, state);
  visitFreeReferenceNode(loop.body, loopScope, state);
};

const switchLexicalBindingNames = (statement) =>
  blockLexicalBindingNames(
    statement.cases.flatMap(({ consequent }) => consequent)
  );

const visitFreeReferenceSwitchCase = (switchCase, switchScope, state) => {
  visitFreeReferenceNode(switchCase.test, switchScope, state);
  switchCase.consequent.forEach((child) =>
    visitFreeReferenceNode(child, switchScope, state)
  );
};

const visitFreeReferenceSwitch = (statement, shadowed, state) => {
  visitFreeReferenceNode(statement.discriminant, shadowed, state);
  const switchScope = withShadowedNames(
    shadowed,
    switchLexicalBindingNames(statement)
  );
  statement.cases.forEach((switchCase) =>
    visitFreeReferenceSwitchCase(switchCase, switchScope, state)
  );
};

const visitFreeReferenceProperty = (property, shadowed, state) => {
  if (property.computed) {
    visitFreeReferenceNode(property.key, shadowed, state);
  }
  visitFreeReferenceNode(property.value, shadowed, state);
};

const visitFreeReferenceClass = (classNode, shadowed, state) => {
  const classNames = new Set();
  if (classNode.id) classNames.add(classNode.id.name);
  const classScope = withShadowedNames(shadowed, classNames);
  visitFreeReferenceNode(classNode.superClass, classScope, state);
  visitFreeReferenceNode(classNode.body, classScope, state);
};

const visitFreeReferenceMember = (member, shadowed, state) => {
  visitFreeReferenceNode(member.object, shadowed, state);
  if (member.computed) {
    visitFreeReferenceNode(member.property, shadowed, state);
  }
};

const visitFreeReferenceDefinedProperty = (property, shadowed, state) => {
  if (property.computed) {
    visitFreeReferenceNode(property.key, shadowed, state);
  }
  visitFreeReferenceNode(property.value, shadowed, state);
};

const visitFreeReferenceLabel = (statement, shadowed, state) => {
  visitFreeReferenceNode(statement.body, shadowed, state);
};

const visitFreeReferenceExport = (statement, shadowed, state) => {
  visitFreeReferenceNode(statement.declaration, shadowed, state);
};

const visitFreeReferenceChildren = (node, shadowed, state) => {
  astVisitorChildren(node).forEach((child) =>
    visitFreeReferenceNode(child, shadowed, state)
  );
};

const freeReferenceNodeReaders = {
  ArrowFunctionExpression: visitFreeReferenceFunction,
  BlockStatement: visitFreeReferenceBlock,
  BreakStatement: noFreeReference,
  CatchClause: visitFreeReferenceCatch,
  ClassDeclaration: visitFreeReferenceClass,
  ClassExpression: visitFreeReferenceClass,
  ContinueStatement: noFreeReference,
  ExportDefaultDeclaration: visitFreeReferenceExport,
  ExportNamedDeclaration: visitFreeReferenceExport,
  ForInStatement: visitFreeReferenceLoop,
  ForOfStatement: visitFreeReferenceLoop,
  ForStatement: visitFreeReferenceLoop,
  FunctionDeclaration: visitFreeReferenceFunction,
  FunctionExpression: visitFreeReferenceFunction,
  Identifier: recordFreeIdentifierReference,
  ImportDeclaration: noFreeReference,
  LabeledStatement: visitFreeReferenceLabel,
  MemberExpression: visitFreeReferenceMember,
  MetaProperty: noFreeReference,
  MethodDefinition: visitFreeReferenceDefinedProperty,
  Property: visitFreeReferenceProperty,
  PropertyDefinition: visitFreeReferenceDefinedProperty,
  StaticBlock: visitFreeReferenceBlock,
  SwitchStatement: visitFreeReferenceSwitch,
  VariableDeclaration: visitFreeReferenceVariableDeclaration,
};

function visitFreeReferenceNode(node, shadowed, state) {
  if (!node) return;
  const reader =
    freeReferenceNodeReaders[node.type] ?? visitFreeReferenceChildren;
  reader(node, shadowed, state);
}

const freeReferenceTraversalDepthLimit = 512;
const freeReferenceTraversalDepthMessage =
  'artifact owner free-reference analysis exceeded bounded AST depth';

const assertFreeReferenceTraversalBound = (root) => {
  const pending = [{ depth: 0, node: root }];
  let work = 0;
  while (pending.length > 0) {
    const { depth, node } = pending.pop();
    work += 1;
    assert(
      depth <= freeReferenceTraversalDepthLimit,
      freeReferenceTraversalDepthMessage
    );
    assert(
      work <= runtimeArtifactTraversalWorkLimit,
      runtimeArtifactTraversalWorkMessage
    );
    const children = astVisitorChildren(node);
    assert(
      work + pending.length + children.length <=
        runtimeArtifactTraversalWorkLimit,
      runtimeArtifactTraversalWorkMessage
    );
    children.forEach((child) =>
      pending.push({ depth: depth + 1, node: child })
    );
  }
};

const collectFreeIdentifierReferences = (root) => {
  assertFreeReferenceTraversalBound(root);
  const state = { names: new Set(), nodes: new WeakSet() };
  visitFreeReferenceNode(root, new Set(), state);
  return state;
};

const freeIdentifierNames = (node) =>
  collectFreeIdentifierReferences(node).names;

export const inspectFreeIdentifierReferencesForTesting = (source) => {
  const program = parseModuleSource(
    'free-references.fixture.js',
    source
  ).program;
  return [...freeIdentifierNames(program)].toSorted(compareCodePointStrings);
};

const uniqueTopLevelOwners = (program, message) => {
  const entries = program.body.flatMap(topLevelOwnerEntries);
  const owners = new Map(entries);
  assert(entries.length === owners.size, message);
  return owners;
};

const topLevelOwnerReferenceNode = (owner) =>
  owner.node.type === 'VariableDeclarator' ? owner.node.init : owner.node;

const enqueueReferencedOwners = (pending, owners, node) => {
  for (const reference of freeIdentifierNames(node)) {
    if (owners.has(reference)) {
      pending.push({ enforceConsumerResolution: false, name: reference });
    }
  }
};

const assertNoUnresolvedOwnerConsumers = (
  name,
  unresolvedConsumersByOwner,
  message
) => {
  const unresolvedConsumers = unresolvedConsumersByOwner.get(name) ?? [];
  const [unresolvedConsumer] = unresolvedConsumers;
  assert(
    unresolvedConsumers.length === 0,
    `${message}: reviewed owner ${name} must not escape to an unresolved runtime consumer (${nodeType(unresolvedConsumer)}@${String(unresolvedConsumer?.start)}:${String(unresolvedConsumer?.end)})`
  );
};

const topLevelOwnerVisitComplete = (
  current,
  reachable,
  consumerResolutionOwners
) =>
  reachable.has(current.name) &&
  (!current.enforceConsumerResolution ||
    consumerResolutionOwners.has(current.name));

const enforceTopLevelOwnerConsumerResolution = (
  current,
  consumerResolutionOwners,
  unresolvedConsumersByOwner,
  message
) => {
  if (!current.enforceConsumerResolution) return;
  assertNoUnresolvedOwnerConsumers(
    current.name,
    unresolvedConsumersByOwner,
    message
  );
  consumerResolutionOwners.add(current.name);
};

const enqueueTopLevelOwnerConsumers = (
  pending,
  current,
  consumerNamesByOwner,
  budget
) => {
  const consumers = [...(consumerNamesByOwner.get(current.name) ?? [])];
  assert(
    budget.work + pending.length + consumers.length <=
      cloudflareAnalysisWorkLimit,
    cloudflareAnalysisWorkMessage
  );
  consumers.forEach((name) =>
    pending.push({
      enforceConsumerResolution: current.enforceConsumerResolution,
      name,
    })
  );
};

const visitTopLevelOwner = (
  current,
  pending,
  reachable,
  consumerResolutionOwners,
  owners,
  consumerNamesByOwner,
  unresolvedConsumersByOwner,
  message,
  budget
) => {
  if (topLevelOwnerVisitComplete(current, reachable, consumerResolutionOwners))
    return;
  const owner = owners.get(current.name);
  if (!owner) return;
  enforceTopLevelOwnerConsumerResolution(
    current,
    consumerResolutionOwners,
    unresolvedConsumersByOwner,
    message
  );
  if (!reachable.has(current.name)) {
    reachable.add(current.name);
    enqueueReferencedOwners(pending, owners, topLevelOwnerReferenceNode(owner));
  }
  enqueueTopLevelOwnerConsumers(pending, current, consumerNamesByOwner, budget);
};

const reachableTopLevelOwners = (
  owners,
  initialName,
  {
    consumerNamesByOwner = new Map(),
    enforceConsumerResolution = true,
    message = 'reviewed artifact owner',
    unresolvedConsumersByOwner = new Map(),
  } = {}
) => {
  const pending = [{ enforceConsumerResolution, name: initialName }];
  const reachable = new Set();
  const consumerResolutionOwners = new Set();
  const budget = { work: 0 };
  while (pending.length > 0) {
    budget.work += 1;
    assert(
      budget.work + pending.length <= cloudflareAnalysisWorkLimit,
      cloudflareAnalysisWorkMessage
    );
    visitTopLevelOwner(
      pending.pop(),
      pending,
      reachable,
      consumerResolutionOwners,
      owners,
      consumerNamesByOwner,
      unresolvedConsumersByOwner,
      message,
      budget
    );
  }
  return reachable;
};

export const inspectTopLevelOwnerConsumerBoundForTesting = (degree) =>
  reachableTopLevelOwners(
    new Map([['root', { node: { type: 'Literal', value: 0 } }]]),
    'root',
    {
      consumerNamesByOwner: new Map([
        [
          'root',
          new Set(
            Array.from(
              { length: degree },
              (_unused, index) => `consumer-${index}`
            )
          ),
        ],
      ]),
    }
  ).size;

const artifactOwnerModuleSource = (
  source,
  kind,
  chunkFile,
  manifestRecord,
  manifestRecordFor,
  message
) => {
  if (!source.startsWith('.')) {
    assert(reviewedCloudflareClosureExternals.has(source), message);
    return `${kind}:external:${source}`;
  }
  const linkedFile = path.resolve(path.dirname(chunkFile), source);
  assert(isWithinDirectory(linkedFile, manifestRecord.artifactRoot), message);
  assertFile(linkedFile);
  assert(
    isWithinDirectory(
      fs.realpathSync(linkedFile),
      fs.realpathSync(manifestRecord.artifactRoot)
    ),
    message
  );
  const linkedRecord = manifestRecordFor(linkedFile);
  return `${kind}:internal:${manifestRecordNodeIdentity(
    linkedRecord,
    linkedRecord.key,
    message
  )}`;
};

const identifierReferenceNames = (node, referenceNodes) => {
  const names = new Set();
  new Visitor({
    Identifier(identifier) {
      if (referenceNodes.has(identifier)) names.add(identifier.name);
    },
  }).visit(node);
  return names;
};

const directArtifactOwnerMutationNames = (target, owners, referenceNodes) => {
  const references = identifierReferenceNames(target, referenceNodes);
  return new Set(
    mutationTargetNames(target).filter(
      (name) => owners.has(name) && references.has(name)
    )
  );
};

const reachableArtifactOwnerNames = (reference, owners, cache) => {
  const cached = cache.get(reference);
  if (cached) return cached;
  const reachable = reachableTopLevelOwners(owners, reference);
  cache.set(reference, reachable);
  return reachable;
};

const referencedArtifactOwnerNames = (
  target,
  owners,
  cache,
  referenceNodes,
  readReferences = identifierReferenceNames
) => {
  const referencedOwners = new Set();
  for (const reference of readReferences(target, referenceNodes)) {
    if (!owners.has(reference)) continue;
    for (const ownerName of reachableArtifactOwnerNames(
      reference,
      owners,
      cache
    )) {
      referencedOwners.add(ownerName);
    }
  }
  return referencedOwners;
};

const artifactOwnerMutationNames = (target, owners, cache, referenceNodes) =>
  nodeType(target) === 'MemberExpression'
    ? referencedArtifactOwnerNames(target.object, owners, cache, referenceNodes)
    : directArtifactOwnerMutationNames(target, owners, referenceNodes);

const recordArtifactOwnerMutationDigest = (
  mutationsByOwner,
  ownerName,
  digest,
  recordKey = digest
) => {
  const mutations = mutationsByOwner.get(ownerName) ?? new Map();
  mutations.set(recordKey, digest);
  mutationsByOwner.set(ownerName, mutations);
};

const appendArtifactOwnerMutation = (
  mutationsByOwner,
  dormantRanges,
  node,
  mutatedOwners
) => {
  if (mutatedOwners.size === 0) return;
  if (isInsideNestedFunction(node, dormantRanges)) return;
  const digest = astDigest(node);
  mutatedOwners.forEach((ownerName) =>
    recordArtifactOwnerMutationDigest(mutationsByOwner, ownerName, digest, node)
  );
};

const artifactOwnerConsumerReverseIndexes = new WeakMap();

const recordArtifactOwnerConsumer = (consumerNamesByOwner, ownerName, name) => {
  const consumers = consumerNamesByOwner.get(ownerName) ?? new Set();
  consumers.add(name);
  consumerNamesByOwner.set(ownerName, consumers);
  const reverseIndex =
    artifactOwnerConsumerReverseIndexes.get(consumerNamesByOwner);
  if (reverseIndex) {
    const sources = reverseIndex.get(name) ?? new Set();
    sources.add(ownerName);
    reverseIndex.set(name, sources);
  }
};

const artifactOwnerConsumerReverseIndex = (consumerNamesByOwner) => {
  const cached = artifactOwnerConsumerReverseIndexes.get(consumerNamesByOwner);
  if (cached) return cached;
  const reverseIndex = new Map();
  consumerNamesByOwner.forEach((consumerNames, ownerName) =>
    consumerNames.forEach((name) => {
      const sources = reverseIndex.get(name) ?? new Set();
      sources.add(ownerName);
      reverseIndex.set(name, sources);
    })
  );
  artifactOwnerConsumerReverseIndexes.set(consumerNamesByOwner, reverseIndex);
  return reverseIndex;
};

const recordArtifactOwnerImportConsumer = (
  importConsumerNamesByOwner,
  ownerName,
  reference
) => {
  const consumers = importConsumerNamesByOwner.get(ownerName) ?? new Set();
  consumers.add(reference);
  importConsumerNamesByOwner.set(ownerName, consumers);
};

const recordUnresolvedArtifactOwnerConsumer = (
  unresolvedConsumersByOwner,
  ownerName,
  node
) => {
  const consumers = unresolvedConsumersByOwner.get(ownerName) ?? [];
  consumers.push(node);
  unresolvedConsumersByOwner.set(ownerName, consumers);
};

const artifactOwnerExecutionTarget = (node) =>
  nodeType(node) === 'TaggedTemplateExpression' ? node.tag : node.callee;

const artifactOwnerExecutionReceiver = (node) => {
  const callee = unwrapCloudflareExecutionTarget(
    artifactOwnerExecutionTarget(node)
  );
  if (nodeType(callee) !== 'MemberExpression') return undefined;
  if (new Set(['apply', 'bind', 'call']).has(cloudflareMemberName(callee))) {
    return undefined;
  }
  return callee.object;
};

const artifactOwnerExecutionArguments = (node) =>
  nodeType(node) === 'TaggedTemplateExpression'
    ? node.quasi.expressions
    : cloudflareExecutionArguments(node);

const artifactOwnerNamesFromValues = (
  values,
  context,
  anchor,
  seenBindings = new Set()
) => {
  const names = new Set();
  values.forEach((value) => {
    artifactOwnerNamesFromValue(value, context, anchor, seenBindings).forEach(
      (name) => names.add(name)
    );
  });
  return names;
};

const artifactOwnerConsumerNames = (node, context) =>
  artifactOwnerNamesFromValues(
    artifactOwnerExecutionArguments(node),
    context,
    node
  );

const artifactOwnerReceiverNames = (node, context) => {
  const receiver = artifactOwnerExecutionReceiver(node);
  return receiver
    ? artifactOwnerNamesFromValues([receiver], context, node)
    : new Set();
};

const artifactOwnerNamesByReferenceNode = (owners) => {
  const namesByNode = new WeakMap();
  owners.forEach((owner, name) => {
    const node = topLevelOwnerReferenceNode(owner);
    if (!node) return;
    const names = namesByNode.get(node) ?? [];
    names.push(name);
    namesByNode.set(node, names);
  });
  return namesByNode;
};

const containingArtifactOwnerNames = (node, context) => {
  let current = node;
  while (current) {
    const names = context.ownerNamesByReferenceNode.get(current);
    if (names) return names;
    current = context.parentNodes.get(current);
  }
  return [];
};

const reviewedArtifactOwnerAmbientConsumers = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'cancelAnimationFrame',
  'cancelIdleCallback',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'CSS',
  'customElements',
  'Date',
  'DataView',
  'document',
  'DOMException',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'globalThis',
  'Intl',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'isFinite',
  'isNaN',
  'JSON',
  'history',
  'localStorage',
  'location',
  'Map',
  'Math',
  'Number',
  'navigator',
  'Object',
  'Promise',
  'parseFloat',
  'parseInt',
  'Proxy',
  'queueMicrotask',
  'RangeError',
  'RegExp',
  'ReferenceError',
  'requestAnimationFrame',
  'requestIdleCallback',
  'Reflect',
  'sessionStorage',
  'self',
  'SharedArrayBuffer',
  'Set',
  'String',
  'structuredClone',
  'SyntaxError',
  'Symbol',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WebAssembly',
  'window',
]);

const recordContainedArtifactOwnerConsumer = (node, context, ownerNames) => {
  const containingOwners = containingArtifactOwnerNames(node, context);
  ownerNames.forEach((ownerName) =>
    containingOwners.forEach((consumerName) =>
      recordArtifactOwnerConsumer(
        context.consumerNamesByOwner,
        ownerName,
        consumerName
      )
    )
  );
};

const recordArtifactOwnerConsumerRelations = (
  ownerNames,
  consumerNames,
  context
) => {
  const [firstConsumer, ...remainingConsumers] = consumerNames;
  if (!firstConsumer) return;
  ownerNames.forEach((ownerName) =>
    recordArtifactOwnerConsumer(
      context.consumerNamesByOwner,
      ownerName,
      firstConsumer
    )
  );
  remainingConsumers.forEach((consumerName) =>
    recordArtifactOwnerConsumer(
      context.consumerNamesByOwner,
      firstConsumer,
      consumerName
    )
  );
};

const recordArtifactOwnerValueRelations = (ownerNames, context) => {
  const [first, ...rest] = ownerNames;
  if (!first) return;
  rest.forEach((name) => {
    recordArtifactOwnerConsumer(context.consumerNamesByOwner, first, name);
    recordArtifactOwnerConsumer(context.consumerNamesByOwner, name, first);
  });
};

const artifactOwnerImportedReferences = (references, context) =>
  new Set(
    [...references].filter((reference) =>
      context.staticImportsByLocalName.has(reference)
    )
  );

const recordArtifactOwnerImportConsumers = (
  references,
  context,
  ownerNames
) => {
  const importedReferences = artifactOwnerImportedReferences(
    references,
    context
  );
  ownerNames.forEach((ownerName) =>
    importedReferences.forEach((reference) =>
      recordArtifactOwnerImportConsumer(
        context.importConsumerNamesByOwner,
        ownerName,
        reference
      )
    )
  );
  return importedReferences;
};

const createAstParentMap = (root) => {
  const parents = new WeakMap();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    const children = astVisitorChildren(node);
    children.forEach((child) => parents.set(child, node));
    children.forEach((child) => pending.push(child));
  }
  return parents;
};

const artifactOwnerLexicalScopeTypes = new Set([
  'ArrowFunctionExpression',
  'BlockStatement',
  'CatchClause',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'Program',
  'StaticBlock',
  'SwitchStatement',
]);

const artifactOwnerLexicalScope = (node, parentNodes) => {
  let current = parentNodes.get(node);
  while (current && !artifactOwnerLexicalScopeTypes.has(current.type)) {
    current = parentNodes.get(current);
  }
  return current;
};

const artifactOwnerLexicalStatements = (scope) => {
  if (
    new Set(['BlockStatement', 'Program', 'StaticBlock']).has(nodeType(scope))
  ) {
    return scope.body;
  }
  if (nodeType(scope) === 'SwitchStatement') {
    return scope.cases.flatMap(({ consequent }) => consequent);
  }
  return [];
};

const noArtifactOwnerBindingDefaults = () => [];

const artifactOwnerAssignmentBindingDefaults = (pattern, name) => [
  ...artifactOwnerBindingDefaultValuesUnchecked(pattern.left, name),
  ...(bindingNames(pattern.left).includes(name) ? [pattern.right] : []),
];

const artifactOwnerArrayBindingDefaults = (pattern, name) =>
  pattern.elements.flatMap((element) =>
    artifactOwnerBindingDefaultValuesUnchecked(element, name)
  );

const artifactOwnerObjectBindingDefaults = (pattern, name) =>
  pattern.properties.flatMap((property) =>
    artifactOwnerBindingDefaultValuesUnchecked(
      property.value ?? property.argument,
      name
    )
  );

const artifactOwnerRestBindingDefaults = (pattern, name) =>
  artifactOwnerBindingDefaultValuesUnchecked(pattern.argument, name);

const artifactOwnerBindingDefaultReaders = {
  ArrayPattern: artifactOwnerArrayBindingDefaults,
  AssignmentPattern: artifactOwnerAssignmentBindingDefaults,
  ObjectPattern: artifactOwnerObjectBindingDefaults,
  RestElement: artifactOwnerRestBindingDefaults,
};

function artifactOwnerBindingDefaultValuesUnchecked(pattern, name) {
  const reader =
    artifactOwnerBindingDefaultReaders[nodeType(pattern)] ??
    noArtifactOwnerBindingDefaults;
  return reader(pattern, name);
}

function artifactOwnerBindingDefaultValues(pattern, name) {
  assertArtifactPatternBound(pattern);
  return artifactOwnerBindingDefaultValuesUnchecked(pattern, name);
}

const artifactOwnerDeclaratorBinding = (declarator, name, scope) => ({
  defaultValues: artifactOwnerBindingDefaultValues(declarator.id, name),
  digestNode: declarator,
  scope,
  value: declarator.init,
});

const artifactOwnerLexicalVariableEntries = (statement, scope) =>
  statement.kind === 'var'
    ? []
    : statement.declarations.flatMap((declarator) =>
        bindingNames(declarator.id).map((name) => [
          name,
          artifactOwnerDeclaratorBinding(declarator, name, scope),
        ])
      );

const artifactOwnerLexicalDeclaredEntries = (statement, scope) =>
  statement.id
    ? [[statement.id.name, { digestNode: statement, scope, value: statement }]]
    : [];

const artifactOwnerLexicalDeclarationReaders = {
  ClassDeclaration: artifactOwnerLexicalDeclaredEntries,
  FunctionDeclaration: artifactOwnerLexicalDeclaredEntries,
  VariableDeclaration: artifactOwnerLexicalVariableEntries,
};

const artifactOwnerLexicalDeclarationEntries = (statement, scope) =>
  (
    artifactOwnerLexicalDeclarationReaders[nodeType(statement)] ??
    noOwnerEntries
  )(statement, scope);

const artifactOwnerLoopBindingEntries = (scope) => {
  const declaration = scope.init ?? scope.left;
  if (
    nodeType(declaration) !== 'VariableDeclaration' ||
    declaration.kind === 'var'
  ) {
    return [];
  }
  return declaration.declarations.flatMap((declarator) =>
    bindingNames(declarator.id).map((name) => [
      name,
      {
        defaultValues: artifactOwnerBindingDefaultValues(declarator.id, name),
        digestNode: declarator,
        scope,
        value:
          nodeType(scope) === 'ForOfStatement'
            ? scope.right
            : nodeType(scope) === 'ForInStatement'
              ? undefined
              : declarator.init,
      },
    ])
  );
};

const artifactOwnerCatchBindingEntries = (scope) =>
  bindingNames(scope.param).map((name) => [
    name,
    {
      defaultValues: artifactOwnerBindingDefaultValues(scope.param, name),
      digestNode: scope.param,
      scope,
      value: undefined,
    },
  ]);

const artifactOwnerParameterBindingEntries = (scope) =>
  scope.params.flatMap((parameter) =>
    bindingNames(parameter).map((name) => [
      name,
      {
        defaultValues: artifactOwnerBindingDefaultValues(parameter, name),
        digestNode: parameter,
        scope,
        value: undefined,
      },
    ])
  );

const artifactOwnerFunctionVarBindingEntries = (scope) => {
  const entries = [];
  const nestedRanges = nestedFunctionRanges(scope);
  new Visitor({
    VariableDeclaration(statement) {
      if (
        statement.kind !== 'var' ||
        isInsideNestedFunction(statement, nestedRanges)
      ) {
        return;
      }
      statement.declarations.forEach((declarator) =>
        bindingNames(declarator.id).forEach((name) =>
          entries.push([
            name,
            artifactOwnerDeclaratorBinding(declarator, name, scope),
          ])
        )
      );
    },
  }).visit(scope.body);
  return entries;
};

const artifactOwnerFunctionBindingEntries = (scope) => [
  ...artifactOwnerParameterBindingEntries(scope),
  ...artifactOwnerFunctionVarBindingEntries(scope),
];

const artifactOwnerFunctionScopeTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

const readArtifactOwnerLexicalBindingEntries = (scope) => {
  if (artifactOwnerFunctionScopeTypes.has(nodeType(scope))) {
    return artifactOwnerFunctionBindingEntries(scope);
  }
  if (nodeType(scope) === 'CatchClause') {
    return artifactOwnerCatchBindingEntries(scope);
  }
  if (
    new Set(['ForInStatement', 'ForOfStatement', 'ForStatement']).has(
      nodeType(scope)
    )
  ) {
    return artifactOwnerLoopBindingEntries(scope);
  }
  return artifactOwnerLexicalStatements(scope).flatMap((statement) =>
    artifactOwnerLexicalDeclarationEntries(statement, scope)
  );
};

const artifactOwnerLexicalBindingEntries = (scope, context) => {
  const cached = context.lexicalEntriesByScope.get(scope);
  if (cached) return cached;
  const entries = readArtifactOwnerLexicalBindingEntries(scope);
  context.lexicalEntriesByScope.set(scope, entries);
  return entries;
};

const findArtifactOwnerLexicalBinding = (node, name, context) => {
  let scope = artifactOwnerLexicalScope(node, context.parentNodes);
  while (scope) {
    const binding = artifactOwnerLexicalBindingEntries(scope, context).find(
      ([bindingName]) => bindingName === name
    );
    if (binding) return binding[1];
    scope = artifactOwnerLexicalScope(scope, context.parentNodes);
  }
  return undefined;
};

const cacheArtifactOwnerLexicalBinding = (
  context,
  node,
  cachedByName,
  name,
  binding
) => {
  const byName = cachedByName ?? new Map();
  byName.set(name, binding);
  context.lexicalBindingsByNode.set(node, byName);
  return binding;
};

const artifactOwnerLexicalBinding = (node, name, context) => {
  const cachedByName = context.lexicalBindingsByNode.get(node);
  if (cachedByName?.has(name)) return cachedByName.get(name);
  return cacheArtifactOwnerLexicalBinding(
    context,
    node,
    cachedByName,
    name,
    findArtifactOwnerLexicalBinding(node, name, context)
  );
};

const recordArtifactOwnerLexicalMutation = (
  index,
  node,
  target,
  readValues,
  context
) => {
  mutationTargetNames(target).forEach((name) => {
    const binding = artifactOwnerLexicalBinding(node, name, context);
    if (!binding) return;
    const byName = index.get(binding.digestNode) ?? new Map();
    const mutations = byName.get(name) ?? [];
    mutations.push({ node, values: readValues(name) });
    byName.set(name, mutations);
    index.set(binding.digestNode, byName);
  });
};

const createArtifactOwnerLexicalMutationIndex = (context) => {
  const index = new WeakMap();
  new Visitor({
    AssignmentExpression(node) {
      recordArtifactOwnerLexicalMutation(
        index,
        node,
        node.left,
        (name) => [
          node.right,
          ...artifactOwnerBindingDefaultValues(node.left, name),
        ],
        context
      );
    },
    ForInStatement(node) {
      recordArtifactOwnerLexicalMutation(
        index,
        node,
        node.left,
        () => [],
        context
      );
    },
    ForOfStatement(node) {
      recordArtifactOwnerLexicalMutation(
        index,
        node,
        node.left,
        (name) => [
          node.right,
          ...artifactOwnerBindingDefaultValues(node.left, name),
        ],
        context
      );
    },
    UpdateExpression(node) {
      recordArtifactOwnerLexicalMutation(
        index,
        node,
        node.argument,
        () => [],
        context
      );
    },
  }).visit(context.program);
  return index;
};

const artifactOwnerLexicalMutationIndex = (context) => {
  context.lexicalMutationIndex ??=
    createArtifactOwnerLexicalMutationIndex(context);
  return context.lexicalMutationIndex;
};

const artifactOwnerLexicalMutations = (binding, name, context) =>
  artifactOwnerLexicalMutationIndex(context)
    .get(binding.digestNode)
    ?.get(name) ?? [];

const artifactOwnerLexicalDigest = (node, context) => {
  const cached = context.lexicalDigests.get(node);
  if (cached) return cached;
  const digest = astDigest(node);
  context.lexicalDigests.set(node, digest);
  return digest;
};

const artifactOwnerLexicalValueNodes = (binding, name, context) => [
  ...(binding.value ? [binding.value] : []),
  ...(binding.defaultValues ?? []),
  ...artifactOwnerLexicalMutations(binding, name, context).flatMap(
    ({ values }) => values
  ),
];

const recordArtifactOwnerLexicalBindingDigests = (
  binding,
  name,
  context,
  ownerNames
) => {
  const nodes = [
    binding.digestNode,
    ...artifactOwnerLexicalMutations(binding, name, context).map(
      ({ node }) => node
    ),
  ];
  ownerNames.forEach((ownerName) =>
    nodes.forEach((node) =>
      recordArtifactOwnerMutationDigest(
        context.mutationsByOwner,
        ownerName,
        artifactOwnerLexicalDigest(node, context),
        node
      )
    )
  );
};

const staticMemberName = (member) => {
  if (nodeType(member) !== 'MemberExpression') return undefined;
  return member.computed
    ? literalString(member.property)
    : identifierName(member.property);
};

const ambientSymbolCalleeName = (node) => {
  const callee = unwrapCloudflareExecutionTarget(node.callee);
  return (
    identifierName(callee) ??
    (nodeType(callee) === 'MemberExpression'
      ? identifierName(callee.object)
      : undefined)
  );
};

const isUnshadowedAmbientSymbol = (symbolName, bindings, program) =>
  symbolName === 'Symbol' &&
  !bindings.has(symbolName) &&
  !findStaticImport(program, symbolName);

const isAmbientSymbolKey = (node, bindings, program) =>
  nodeType(node) === 'CallExpression' &&
  isUnshadowedAmbientSymbol(ambientSymbolCalleeName(node), bindings, program);

const computedAmbientOverrideName = (property, bindings, program) => {
  const resolved = resolveCloudflareTarget(property, bindings);
  if (isAmbientSymbolKey(resolved, bindings, program)) return undefined;
  return literalString(resolved) ?? '*';
};

const ambientMemberOverrideName = (target, bindings, program) =>
  target.computed
    ? computedAmbientOverrideName(target.property, bindings, program)
    : identifierName(target.property);

const isUnshadowedArtifactAmbient = (name, bindings, program) =>
  !bindings.has(name) && !findStaticImport(program, name);

const artifactAmbientIdentityForName = (name) => {
  if (cloudflareGlobalOwners.has(name)) return { kind: 'global' };
  if (reviewedArtifactOwnerAmbientConsumers.has(name)) {
    return { kind: 'ambient', name };
  }
  return undefined;
};

const artifactAmbientIdentifierIdentity = (node, bindings, program) => {
  const name = identifierName(node);
  return name && isUnshadowedArtifactAmbient(name, bindings, program)
    ? artifactAmbientIdentityForName(name)
    : undefined;
};

const artifactAmbientGlobalMemberIdentity = (node, bindings, program) => {
  const name = ambientMemberOverrideName(node, bindings, program);
  if (!name) return undefined;
  return reviewedArtifactOwnerAmbientConsumers.has(name)
    ? { kind: 'ambient', name }
    : { kind: 'global-property', name };
};

const artifactAmbientMemberIdentityReaders = {
  ambient: (_node, _bindings, _program, objectIdentity) => objectIdentity,
  global: artifactAmbientGlobalMemberIdentity,
  'global-property': artifactAmbientGlobalMemberIdentity,
};

const artifactAmbientMemberIdentity = (node, bindings, program) => {
  const objectIdentity = artifactAmbientObjectIdentity(
    node.object,
    bindings,
    program
  );
  const reader = artifactAmbientMemberIdentityReaders[objectIdentity?.kind];
  return reader?.(node, bindings, program, objectIdentity);
};

const noArtifactAmbientIdentity = () => undefined;
const artifactAmbientObjectIdentityReaders = {
  Identifier: artifactAmbientIdentifierIdentity,
  MemberExpression: artifactAmbientMemberIdentity,
};

function artifactAmbientObjectIdentity(node, bindings, program) {
  const resolved = resolveCloudflareTarget(node, bindings);
  const reader =
    artifactAmbientObjectIdentityReaders[nodeType(resolved)] ??
    noArtifactAmbientIdentity;
  return reader(resolved, bindings, program);
}

const artifactAmbientMutationName = (target, bindings, program) => {
  const identity = artifactAmbientObjectIdentity(target, bindings, program);
  return identity?.kind === 'ambient' ? identity.name : undefined;
};

const recordAmbientMutationTarget = (overrides, target, bindings, program) => {
  visitAstSubtree(target, {
    Identifier(node) {
      const name = artifactAmbientMutationName(node, bindings, program);
      if (name) overrides.add(name);
    },
    MemberExpression(node) {
      const name = artifactAmbientMutationName(node, bindings, program);
      if (name) overrides.add(name);
    },
  });
};

const ambientObjectPropertyNames = (node) => {
  if (nodeType(node) !== 'ObjectExpression') return undefined;
  const names = node.properties.map((property) => {
    if (property.type === 'SpreadElement') return undefined;
    if (property.computed) return literalString(property.key);
    return propertyKeyName(property);
  });
  return names.every(Boolean) ? new Set(names) : new Set(['*']);
};

const ambientDescriptorPropertyNames = (node) => {
  const direct = ambientObjectPropertyNames(node);
  if (direct) return direct;
  if (nodeType(node) !== 'CallExpression') return new Set(['*']);
  const nested = node.arguments.map(ambientObjectPropertyNames).filter(Boolean);
  if (nested.length === 0) return new Set(['*']);
  return new Set(nested.flatMap((names) => [...names]));
};

const ambientAssignProperties = (node) => {
  const sources = node.arguments.slice(1).map(ambientDescriptorPropertyNames);
  return new Set(sources.flatMap((names) => [...names]));
};

const ambientSingleProperty = (node) =>
  new Set([literalString(node.arguments[1]) ?? '*']);

const ambientMutationPropertyReaders = new Map([
  ['Object.assign', ambientAssignProperties],
  [
    'Object.defineProperties',
    (node) => ambientDescriptorPropertyNames(node.arguments[1]),
  ],
  ['Object.defineProperty', ambientSingleProperty],
  ['Reflect.defineProperty', ambientSingleProperty],
  ['Reflect.set', ambientSingleProperty],
]);

const ambientMutationTargetKey = (node, bindings, program) => {
  const target = unwrapCloudflareExecutionTarget(node.callee);
  if (nodeType(target) !== 'MemberExpression') return undefined;
  const identity = artifactAmbientObjectIdentity(
    target.object,
    bindings,
    program
  );
  if (identity?.kind !== 'ambient') return undefined;
  return `${identity.name}.${String(staticMemberName(target))}`;
};

const noAmbientMutationProperties = () => new Set();
const ambientMutationProperties = (node, bindings, program) =>
  (
    ambientMutationPropertyReaders.get(
      ambientMutationTargetKey(node, bindings, program)
    ) ?? noAmbientMutationProperties
  )(node);

const ambientLegacyMutationProperties = (node) => {
  const target = unwrapCloudflareExecutionTarget(node.callee);
  if (nodeType(target) !== 'MemberExpression') return new Set();
  return new Set(['__defineGetter__', '__defineSetter__']).has(
    staticMemberName(target)
  )
    ? new Set([literalString(node.arguments[0]) ?? '*'])
    : new Set();
};

const ambientMutationCallProperties = (node, bindings, program) => {
  const properties = ambientMutationProperties(node, bindings, program);
  return properties.size > 0
    ? properties
    : ambientLegacyMutationProperties(node);
};

const ambientMutationCallTarget = (node) => {
  const target = unwrapCloudflareExecutionTarget(node.callee);
  const member = nodeType(target) === 'MemberExpression' ? target : undefined;
  const legacy = new Set(['__defineGetter__', '__defineSetter__']).has(
    staticMemberName(member)
  );
  return legacy ? member.object : node.arguments[0];
};

const noAmbientMutationOverrides = () => new Set();
const ambientMutationOverrideReaders = {
  ambient: (identity) => new Set([identity.name]),
  global: (_identity, properties) => properties,
};

const ambientMutationOverridesForCall = (node, bindings, program) => {
  const properties = ambientMutationCallProperties(node, bindings, program);
  if (properties.size === 0) return new Set();
  const identity = artifactAmbientObjectIdentity(
    ambientMutationCallTarget(node),
    bindings,
    program
  );
  const reader =
    ambientMutationOverrideReaders[identity?.kind] ??
    noAmbientMutationOverrides;
  return reader(identity, properties);
};

const recordAmbientMutationCall = (
  overrides,
  guards,
  node,
  bindings,
  program
) => {
  const properties = ambientMutationOverridesForCall(node, bindings, program);
  if (properties.size === 0) return;
  properties.forEach((property) => overrides.add(property));
  guards.push(node);
};

const artifactOwnerAmbientAnalysis = (program) => {
  const guards = [];
  const overrides = new Set();
  const bindings = cloudflareTopLevelBindings(program);
  new Visitor({
    AssignmentExpression(node) {
      recordAmbientMutationTarget(overrides, node.left, bindings, program);
    },
    CallExpression(node) {
      recordAmbientMutationCall(overrides, guards, node, bindings, program);
    },
    ForInStatement(node) {
      recordAmbientMutationTarget(overrides, node.left, bindings, program);
    },
    ForOfStatement(node) {
      recordAmbientMutationTarget(overrides, node.left, bindings, program);
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') {
        recordAmbientMutationTarget(
          overrides,
          node.argument,
          bindings,
          program
        );
      }
    },
    UpdateExpression(node) {
      recordAmbientMutationTarget(overrides, node.argument, bindings, program);
    },
  }).visit(program);
  return { guards, overrides };
};

const hasArtifactOwnerAmbientOverride = (references, context) =>
  references.size > 0 &&
  (context.ambientOverrides.has('*') ||
    [...references].some((reference) =>
      context.ambientOverrides.has(reference)
    ));

const unresolvedArtifactOwnerTargetReferences = (
  references,
  localNames,
  importedReferences
) =>
  new Set(
    [...references].filter(
      (reference) =>
        !localNames.has(reference) &&
        !importedReferences.has(reference) &&
        !reviewedArtifactOwnerAmbientConsumers.has(reference)
    )
  );

const shadowedArtifactOwnerTargetReferences = (
  target,
  globallyResolvedReferences
) =>
  new Set(
    [...freeIdentifierNames(target)].filter(
      (reference) => !globallyResolvedReferences.has(reference)
    )
  );

const recordUnresolvedArtifactOwnerConsumers = (node, context, ownerNames) => {
  ownerNames.forEach((ownerName) =>
    recordUnresolvedArtifactOwnerConsumer(
      context.unresolvedConsumersByOwner,
      ownerName,
      node
    )
  );
};

const recordArtifactOwnerAmbientGuard = (guard, context, ownerNames) => {
  const digest = astDigest(guard);
  ownerNames.forEach((ownerName) =>
    recordArtifactOwnerMutationDigest(
      context.mutationsByOwner,
      ownerName,
      digest,
      guard
    )
  );
  const dependencies = referencedArtifactOwnerNames(
    guard,
    context.owners,
    context.reachableOwners,
    context.referenceNodes
  );
  recordArtifactOwnerConsumerRelations(ownerNames, dependencies, context);
  recordArtifactOwnerImportConsumers(
    identifierReferenceNames(guard, context.referenceNodes),
    context,
    ownerNames
  );
  recordContainedArtifactOwnerConsumer(guard, context, ownerNames);
};

const recordArtifactOwnerAmbientGuards = (context, ownerNames) =>
  context.ambientGuards.forEach((guard) =>
    recordArtifactOwnerAmbientGuard(guard, context, ownerNames)
  );

const recordShadowedArtifactOwnerTarget = (
  node,
  target,
  references,
  context,
  ownerNames
) => {
  const shadowedReferences = shadowedArtifactOwnerTargetReferences(
    target,
    references
  );
  shadowedReferences.forEach((reference) => {
    const binding = artifactOwnerLexicalBinding(node, reference, context);
    if (!binding) {
      recordUnresolvedArtifactOwnerConsumers(node, context, ownerNames);
      return;
    }
    recordArtifactOwnerLexicalBinding(binding, reference, context, ownerNames);
  });
};

const artifactOwnerAmbientReferences = (references) =>
  new Set(
    [...references].filter((reference) =>
      reviewedArtifactOwnerAmbientConsumers.has(reference)
    )
  );

const recordArtifactOwnerAmbientTarget = (
  ambientReferences,
  context,
  ownerNames
) => {
  if (ambientReferences.size > 0) {
    recordArtifactOwnerAmbientGuards(context, ownerNames);
  }
};

const artifactOwnerDirectAmbientReferences = (node, context) =>
  new Set(
    [...identifierReferenceNames(node, context.referenceNodes)].filter(
      (reference) =>
        reviewedArtifactOwnerAmbientConsumers.has(reference) &&
        !context.owners.has(reference) &&
        !context.staticImportsByLocalName.has(reference)
    )
  );

const recordArtifactOwnerAmbientProvenance = (ownerName, owner, context) => {
  const ownerNode = topLevelOwnerReferenceNode(owner);
  if (!ownerNode) return;
  const ambientReferences = artifactOwnerDirectAmbientReferences(
    ownerNode,
    context
  );
  if (ambientReferences.size === 0) return;
  const ownerNames = new Set([ownerName]);
  recordArtifactOwnerAmbientGuards(context, ownerNames);
  if (hasArtifactOwnerAmbientOverride(ambientReferences, context)) {
    recordUnresolvedArtifactOwnerConsumers(ownerNode, context, ownerNames);
  }
};

const recordArtifactOwnerAmbientProvenances = (context) =>
  context.owners.forEach((owner, ownerName) =>
    recordArtifactOwnerAmbientProvenance(ownerName, owner, context)
  );

const artifactOwnerLexicalReferences = (node, globalReferences) =>
  new Set(
    [...freeIdentifierNames(node)].filter(
      (reference) => !globalReferences.has(reference)
    )
  );

const recordArtifactOwnerLexicalSource = (
  source,
  anchor,
  context,
  ownerNames,
  failOnUnresolved,
  seenBindings
) => {
  const references = identifierReferenceNames(source, context.referenceNodes);
  const localNames = new Set(
    [...references].filter((reference) => context.owners.has(reference))
  );
  recordArtifactOwnerConsumerRelations(ownerNames, localNames, context);
  const importedReferences = recordArtifactOwnerImportConsumers(
    references,
    context,
    ownerNames
  );
  const ambientReferences = artifactOwnerAmbientReferences(references);
  recordArtifactOwnerAmbientTarget(ambientReferences, context, ownerNames);
  const unresolvedReferences = unresolvedArtifactOwnerTargetReferences(
    references,
    localNames,
    importedReferences
  );
  if (
    failOnUnresolved &&
    artifactOwnerTargetIsUnresolved(
      unresolvedReferences,
      ambientReferences,
      context
    )
  ) {
    recordUnresolvedArtifactOwnerConsumers(source, context, ownerNames);
  }
  artifactOwnerLexicalReferences(source, references).forEach((reference) => {
    const binding = artifactOwnerLexicalBinding(anchor, reference, context);
    if (!binding) {
      if (!failOnUnresolved) return;
      recordUnresolvedArtifactOwnerConsumers(source, context, ownerNames);
      return;
    }
    recordArtifactOwnerLexicalBinding(binding, reference, context, ownerNames, {
      failOnUnresolved,
      seenBindings,
    });
  });
};

const recordArtifactOwnerLexicalBinding = (
  binding,
  name,
  context,
  ownerNames,
  { failOnUnresolved = true, seenBindings = new Set() } = {}
) => {
  if (seenBindings.has(binding.digestNode)) return;
  const nextSeen = new Set(seenBindings).add(binding.digestNode);
  recordArtifactOwnerLexicalBindingDigests(binding, name, context, ownerNames);
  artifactOwnerLexicalValueNodes(binding, name, context).forEach((source) =>
    recordArtifactOwnerLexicalSource(
      source,
      binding.digestNode,
      context,
      ownerNames,
      failOnUnresolved,
      nextSeen
    )
  );
};

const artifactOwnerNamesFromLexicalBinding = (
  binding,
  name,
  context,
  seenBindings
) => {
  if (seenBindings.has(binding.digestNode)) return new Set();
  const nextSeen = new Set(seenBindings).add(binding.digestNode);
  const ownerNames = new Set(
    context.lexicalOwnerNamesByBinding.get(binding.digestNode) ?? []
  );
  artifactOwnerLexicalValueNodes(binding, name, context).forEach((source) =>
    artifactOwnerNamesFromValue(
      source,
      context,
      binding.digestNode,
      nextSeen
    ).forEach((ownerName) => ownerNames.add(ownerName))
  );
  if (ownerNames.size > 0) {
    recordArtifactOwnerLexicalBinding(binding, name, context, ownerNames, {
      failOnUnresolved: false,
      seenBindings,
    });
  }
  return ownerNames;
};

const artifactOwnerConsumerSourceNames = (
  targetNames,
  consumerNamesByOwner
) => {
  const reverseIndex = artifactOwnerConsumerReverseIndex(consumerNamesByOwner);
  const sources = new Set();
  const pending = [...targetNames];
  const queued = new Set(pending);
  let work = 0;
  while (pending.length > 0) {
    const targetName = pending.pop();
    queued.delete(targetName);
    const ownerNames = reverseIndex.get(targetName) ?? new Set();
    work += 1;
    assert(
      work + pending.length + ownerNames.size <= cloudflareAnalysisWorkLimit,
      cloudflareAnalysisWorkMessage
    );
    ownerNames.forEach((ownerName) => {
      if (sources.has(ownerName)) return;
      sources.add(ownerName);
      if (queued.has(ownerName)) return;
      queued.add(ownerName);
      pending.push(ownerName);
    });
  }
  return sources;
};

export const inspectArtifactOwnerConsumerSourcesForTesting = (length) => {
  const consumerNamesByOwner = new Map();
  Array.from({ length }, (_unused, index) => {
    const ownerName = `owner-${index}`;
    const consumerName = index === length - 1 ? 'target' : `owner-${index + 1}`;
    recordArtifactOwnerConsumer(consumerNamesByOwner, ownerName, consumerName);
  });
  return artifactOwnerConsumerSourceNames(
    new Set(['target']),
    consumerNamesByOwner
  ).size;
};

const artifactOwnerDirectExecutionResultNames = (target, context) => {
  const references = identifierReferenceNames(target, context.referenceNodes);
  const localNames = new Set(
    [...references].filter((reference) => context.owners.has(reference))
  );
  const resultNames = new Set();
  localNames.forEach((localName) =>
    reachableArtifactOwnerNames(
      localName,
      context.owners,
      context.reachableOwners
    ).forEach((ownerName) => resultNames.add(ownerName))
  );
  return resultNames;
};

const artifactOwnerMemberExecutionResultNames = (target, context) => {
  const receiver = artifactOwnerExecutionReceiver({
    arguments: [],
    callee: target,
    type: 'CallExpression',
  });
  if (!receiver) return new Set();
  const receiverReferences = identifierReferenceNames(
    receiver,
    context.referenceNodes
  );
  const receiverNames = new Set(
    [...receiverReferences].filter((reference) => context.owners.has(reference))
  );
  return artifactOwnerConsumerSourceNames(
    receiverNames,
    context.consumerNamesByOwner
  );
};

const artifactOwnerExecutionResultNames = (execution, context) => {
  const target = unwrapCloudflareExecutionTarget(
    artifactOwnerExecutionTarget(execution)
  );
  return nodeType(target) === 'MemberExpression'
    ? artifactOwnerMemberExecutionResultNames(target, context)
    : artifactOwnerDirectExecutionResultNames(target, context);
};

const mergeArtifactOwnerNames = (...nameSets) =>
  new Set(nameSets.flatMap((names) => [...names]));

function artifactOwnerNamesFromValue(
  value,
  context,
  anchor = value,
  seenBindings = new Set()
) {
  if (new Set(['CallExpression', 'NewExpression']).has(nodeType(value))) {
    return mergeArtifactOwnerNames(
      artifactOwnerNamesFromValues(
        cloudflareExecutionArguments(value),
        context,
        value,
        seenBindings
      ),
      artifactOwnerExecutionResultNames(value, context)
    );
  }
  if (nodeType(value) === 'TaggedTemplateExpression') {
    return mergeArtifactOwnerNames(
      artifactOwnerNamesFromValues(
        value.quasi.expressions,
        context,
        value,
        seenBindings
      ),
      artifactOwnerExecutionResultNames(value, context)
    );
  }
  if (nodeType(value) === 'SequenceExpression') {
    return artifactOwnerNamesFromValue(
      value.expressions.at(-1),
      context,
      anchor,
      seenBindings
    );
  }
  const ownerNames = referencedArtifactOwnerNames(
    value,
    context.owners,
    context.reachableOwners,
    context.referenceNodes
  );
  const globalReferences = identifierReferenceNames(
    value,
    context.referenceNodes
  );
  artifactOwnerLexicalReferences(value, globalReferences).forEach(
    (reference) => {
      const binding = artifactOwnerLexicalBinding(anchor, reference, context);
      if (!binding) return;
      artifactOwnerNamesFromLexicalBinding(
        binding,
        reference,
        context,
        seenBindings
      ).forEach((ownerName) => ownerNames.add(ownerName));
    }
  );
  return ownerNames;
}

const artifactOwnerTargetIsUnresolved = (
  unresolvedReferences,
  ambientReferences,
  context
) =>
  unresolvedReferences.size > 0 ||
  hasArtifactOwnerAmbientOverride(ambientReferences, context);

const recordArtifactOwnerExecutionTarget = (node, context, ownerNames) => {
  const target = artifactOwnerExecutionTarget(node);
  const references = identifierReferenceNames(target, context.referenceNodes);
  const localNames = new Set(
    [...references].filter((reference) => context.owners.has(reference))
  );
  recordArtifactOwnerConsumerRelations(ownerNames, localNames, context);
  const importedReferences = recordArtifactOwnerImportConsumers(
    references,
    context,
    ownerNames
  );
  recordShadowedArtifactOwnerTarget(
    node,
    target,
    references,
    context,
    ownerNames
  );
  const unresolvedReferences = unresolvedArtifactOwnerTargetReferences(
    references,
    localNames,
    importedReferences
  );
  const ambientReferences = artifactOwnerAmbientReferences(references);
  recordArtifactOwnerAmbientTarget(ambientReferences, context, ownerNames);
  if (
    artifactOwnerTargetIsUnresolved(
      unresolvedReferences,
      ambientReferences,
      context
    )
  ) {
    recordUnresolvedArtifactOwnerConsumers(node, context, ownerNames);
  }
};

const recordArtifactOwnerConsumerCall = (node, context, dormantRanges) => {
  if (isInsideNestedFunction(node, dormantRanges)) return;
  const receiverNames = artifactOwnerReceiverNames(node, context);
  appendArtifactOwnerMutation(
    context.mutationsByOwner,
    dormantRanges,
    node,
    receiverNames
  );
  recordContainedArtifactOwnerConsumer(node, context, receiverNames);
  const ownerNames = artifactOwnerConsumerNames(node, context);
  if (ownerNames.size === 0) return;
  appendArtifactOwnerMutation(
    context.mutationsByOwner,
    dormantRanges,
    node,
    ownerNames
  );
  recordArtifactOwnerValueRelations(ownerNames, context);
  recordContainedArtifactOwnerConsumer(node, context, ownerNames);
  recordArtifactOwnerExecutionTarget(node, context, ownerNames);
};

const artifactOwnerValueFlowMutationNames = (target) =>
  nodeType(target) === 'VariableDeclaration'
    ? target.declarations.flatMap(({ id }) => bindingNames(id))
    : mutationTargetNames(target);

const artifactOwnerValueFlowTargetNames = (target, owners) =>
  new Set(
    artifactOwnerValueFlowMutationNames(target).filter((name) =>
      owners.has(name)
    )
  );

const recordArtifactOwnerNonlocalValueFlow = (
  node,
  context,
  sourceNames,
  targetNames,
  lexicalTargets
) => {
  if (
    sourceNames.size === 0 ||
    targetNames.size > 0 ||
    lexicalTargets.length > 0
  ) {
    return;
  }
  recordUnresolvedArtifactOwnerConsumers(node, context, sourceNames);
};

const artifactOwnerValueFlowLexicalTargets = (target, context) =>
  artifactOwnerValueFlowMutationNames(target).flatMap((name) => {
    if (context.owners.has(name)) return [];
    const binding = artifactOwnerLexicalBinding(target, name, context);
    return binding ? [{ binding, name }] : [];
  });

const recordArtifactOwnerValueFlow = (
  node,
  target,
  value,
  context,
  dormantRanges
) => {
  if (isInsideNestedFunction(node, dormantRanges)) return;
  const sourceNames = artifactOwnerNamesFromValue(value, context, node);
  const targetNames = artifactOwnerValueFlowTargetNames(target, context.owners);
  const lexicalTargets = artifactOwnerValueFlowLexicalTargets(target, context);
  recordArtifactOwnerNonlocalValueFlow(
    node,
    context,
    sourceNames,
    targetNames,
    lexicalTargets
  );
  if (sourceNames.size === 0) return;
  appendArtifactOwnerMutation(
    context.mutationsByOwner,
    dormantRanges,
    node,
    sourceNames
  );
  recordArtifactOwnerConsumerRelations(sourceNames, targetNames, context);
  lexicalTargets.forEach(({ binding, name }) =>
    recordArtifactOwnerLexicalBinding(binding, name, context, sourceNames, {
      failOnUnresolved: false,
    })
  );
};

const artifactOwnerTryHandler = (candidate) =>
  nodeType(candidate) === 'TryStatement' ? candidate.handler : undefined;

const artifactOwnerThrowInsideBlock = (throwNode, block) =>
  block.start <= throwNode.start && throwNode.end <= block.end;

const artifactOwnerThrowHandler = (throwNode, candidate) => {
  const handler = artifactOwnerTryHandler(candidate);
  return handler && artifactOwnerThrowInsideBlock(throwNode, candidate.block)
    ? handler
    : undefined;
};

const artifactOwnerCatchBindingsForThrow = (node, context) => {
  let current = context.parentNodes.get(node);
  while (current) {
    const handler = artifactOwnerThrowHandler(node, current);
    if (handler) {
      return artifactOwnerCatchBindingEntries(handler).map(
        ([name, binding]) => ({ binding, name })
      );
    }
    current = context.parentNodes.get(current);
  }
  return [];
};

const recordArtifactOwnerCatchBindingFlow = (
  binding,
  name,
  sourceNames,
  context
) => {
  const existing =
    context.lexicalOwnerNamesByBinding.get(binding.digestNode) ?? new Set();
  sourceNames.forEach((ownerName) => existing.add(ownerName));
  context.lexicalOwnerNamesByBinding.set(binding.digestNode, existing);
  recordArtifactOwnerLexicalBindingDigests(binding, name, context, sourceNames);
};

const recordArtifactOwnerThrowFlow = (node, context, dormantRanges) => {
  if (isInsideNestedFunction(node, dormantRanges)) return;
  const sourceNames = artifactOwnerNamesFromValue(node.argument, context, node);
  if (sourceNames.size === 0) return;
  appendArtifactOwnerMutation(
    context.mutationsByOwner,
    dormantRanges,
    node,
    sourceNames
  );
  artifactOwnerCatchBindingsForThrow(node, context).forEach(
    ({ binding, name }) =>
      recordArtifactOwnerCatchBindingFlow(binding, name, sourceNames, context)
  );
};

const createArtifactOwnerImportsBySource = (program) => {
  const importsBySource = new Map();
  program.body.forEach((statement) => {
    if (nodeType(statement) !== 'ImportDeclaration') return;
    const source = literalString(statement.source);
    if (typeof source !== 'string') return;
    const record = importsBySource.get(source) ?? {
      details: [],
      names: new Set(),
    };
    statement.specifiers.forEach((specifier) => {
      const localName = identifierName(specifier.local);
      const readDetails = staticImportSpecifierDetails[specifier.type];
      if (!localName || !readDetails) return;
      record.names.add(localName);
      record.details.push({ ...readDetails(specifier), localName });
    });
    importsBySource.set(source, record);
  });
  importsBySource.forEach((record) =>
    record.details.sort((left, right) =>
      compareCodePointStrings(JSON.stringify(left), JSON.stringify(right))
    )
  );
  return importsBySource;
};

const artifactOwnerImportsBySource = (context) => {
  context.importsBySource ??= createArtifactOwnerImportsBySource(
    context.program
  );
  return context.importsBySource;
};

const artifactOwnerImportSourceNames = (context, source) =>
  artifactOwnerImportsBySource(context).get(source)?.names ?? new Set();

const artifactOwnerImportSourceDetails = (context, source) =>
  artifactOwnerImportsBySource(context).get(source)?.details ?? [];

const artifactOwnerStatementReferences = (context, statement) => {
  const cached = context.statementReferences.get(statement);
  if (cached) return cached;
  const references = identifierReferenceNames(
    statement,
    context.referenceNodes
  );
  context.statementReferences.set(statement, references);
  return references;
};

const connectArtifactOwnerCallerNames = (graph, names) => {
  const [first, ...rest] = names;
  if (!first) return;
  const firstEdges = graph.get(first) ?? new Set();
  graph.set(first, firstEdges);
  rest.forEach((name) => {
    const edges = graph.get(name) ?? new Set();
    firstEdges.add(name);
    edges.add(first);
    graph.set(name, edges);
  });
};

const artifactOwnerCallerGraphNames = (context) => {
  const importedNames = new Set(
    context.program.body
      .filter((statement) => nodeType(statement) === 'ImportDeclaration')
      .flatMap((statement) =>
        statement.specifiers.flatMap((specifier) => {
          const name = identifierName(specifier.local);
          return name ? [name] : [];
        })
      )
  );
  return new Set([...context.owners.keys(), ...importedNames]);
};

const createArtifactOwnerCallerGraph = (context) => {
  const graph = new Map();
  const graphNames = artifactOwnerCallerGraphNames(context);
  context.program.body.forEach((statement) => {
    const names = new Set([
      ...topLevelOwnerEntries(statement).map(([name]) => name),
      ...[...artifactOwnerStatementReferences(context, statement)].filter(
        (name) => graphNames.has(name)
      ),
    ]);
    connectArtifactOwnerCallerNames(graph, [...names]);
  });
  return graph;
};

const artifactOwnerCallerGraph = (context) => {
  context.callerGraph ??= createArtifactOwnerCallerGraph(context);
  return context.callerGraph;
};

const indexArtifactOwnerCallerComponents = (context) => {
  const graph = artifactOwnerCallerGraph(context);
  const componentByName = new Map();
  let work = 0;
  for (const rootName of graph.keys()) {
    if (componentByName.has(rootName)) continue;
    const component = new Set();
    const pending = [rootName];
    while (pending.length > 0) {
      const name = pending.pop();
      if (component.has(name)) continue;
      component.add(name);
      componentByName.set(name, component);
      work += 1;
      const neighbors = graph.get(name) ?? [];
      assert(
        work + pending.length + neighbors.size <= cloudflareAnalysisWorkLimit,
        cloudflareAnalysisWorkMessage
      );
      neighbors.forEach((neighbor) => pending.push(neighbor));
    }
  }
  return componentByName;
};

export const inspectArtifactOwnerCallerComponentsForTesting = (degree) => {
  const names = Array.from({ length: degree }, (_unused, index) => `n${index}`);
  const graph = new Map([
    ['root', new Set(names)],
    ...names.map((name) => [name, new Set(['root'])]),
  ]);
  return indexArtifactOwnerCallerComponents({ callerGraph: graph }).size;
};

const artifactOwnerStatementCallerNames = (context, statement) =>
  new Set([
    ...topLevelOwnerEntries(statement).map(([name]) => name),
    ...artifactOwnerStatementReferences(context, statement),
  ]);

const createArtifactOwnerCallerInteractionIndex = (context) => {
  const componentByName = indexArtifactOwnerCallerComponents(context);
  const componentIdByComponent = new Map();
  const nodesByComponent = new Map();
  const statementOrder = new WeakMap();
  context.program.body.forEach((statement, index) => {
    statementOrder.set(statement, index);
    if (nodeType(statement) === 'ImportDeclaration') return;
    const components = new Set(
      [...artifactOwnerStatementCallerNames(context, statement)]
        .map((name) => componentByName.get(name))
        .filter(Boolean)
    );
    components.forEach((component) => {
      if (!componentIdByComponent.has(component)) {
        componentIdByComponent.set(component, componentIdByComponent.size);
      }
      const nodes = nodesByComponent.get(component) ?? [];
      nodes.push(statement);
      nodesByComponent.set(component, nodes);
    });
  });
  return {
    componentByName,
    componentIdByComponent,
    nodesByComponent,
    nodesByComponentSet: new Map(),
    statementOrder,
  };
};

const artifactOwnerCallerInteractionIndex = (context) => {
  context.callerInteractionIndex ??=
    createArtifactOwnerCallerInteractionIndex(context);
  return context.callerInteractionIndex;
};

const artifactOwnerCallerInteractionNodes = (context, source) => {
  const index = artifactOwnerCallerInteractionIndex(context);
  const components = new Set(
    [...artifactOwnerImportSourceNames(context, source)]
      .map((name) => index.componentByName.get(name))
      .filter(Boolean)
  );
  const componentSetKey = [...components]
    .map((component) => index.componentIdByComponent.get(component))
    .toSorted((left, right) => left - right)
    .join(',');
  const cached = index.nodesByComponentSet.get(componentSetKey);
  if (cached) return { componentSetKey, nodes: cached };
  const nodes = new Set(
    [...components].flatMap(
      (component) => index.nodesByComponent.get(component) ?? []
    )
  );
  const ordered = [...nodes].toSorted(
    (left, right) =>
      index.statementOrder.get(left) - index.statementOrder.get(right)
  );
  index.nodesByComponentSet.set(componentSetKey, ordered);
  return { componentSetKey, nodes: ordered };
};

const artifactOwnerStatementDigest = (
  context,
  statement,
  moduleSourceReplacement
) => {
  const cached = context.statementDigests.get(statement);
  if (cached) return cached;
  const digest = astDigest(statement, moduleSourceReplacement);
  context.statementDigests.set(statement, digest);
  return digest;
};

const artifactOwnerImportConsumerSources = (ownerName, context) =>
  new Set(
    [...(context.importConsumerNamesByOwner.get(ownerName) ?? [])].flatMap(
      (reference) => {
        const imported = context.staticImportsByLocalName.get(reference);
        return imported?.source ? [imported.source] : [];
      }
    )
  );

const artifactOwnerCallerInteractionDigest = (
  context,
  source,
  moduleSourceReplacement
) => {
  const { componentSetKey, nodes } = artifactOwnerCallerInteractionNodes(
    context,
    source
  );
  const cached = context.callerInteractionDigests.get(componentSetKey);
  if (cached) return cached;
  const interactions = nodes
    .map((node) =>
      artifactOwnerStatementDigest(context, node, moduleSourceReplacement)
    )
    .map((digest, index) => [index, digest]);
  const digest = createHash('sha256')
    .update(JSON.stringify(interactions))
    .digest('hex');
  context.callerInteractionDigests.set(componentSetKey, digest);
  return digest;
};

// An imported consumer is reviewed as a namespace so sibling exports from the
// same module cannot hide mutable state. Cross-module state must remain explicit
// in the reviewed value flow; inferring it would require hashing unrelated
// application chunks and makes production verification unbounded.

const artifactOwnerCallerSourceRecord = (
  source,
  context,
  moduleSourceReplacement
) => {
  const cached = context.callerSourceRecords.get(source);
  if (cached) return cached;
  const record = {
    imports: artifactOwnerImportSourceDetails(context, source),
    interactionDigest: artifactOwnerCallerInteractionDigest(
      context,
      source,
      moduleSourceReplacement
    ),
    source: moduleSourceReplacement(source, 'static'),
  };
  context.callerSourceRecords.set(source, record);
  return record;
};

const recordArtifactOwnerImportConsumerProgram = (
  ownerName,
  context,
  moduleSourceReplacement
) => {
  const sources = artifactOwnerImportConsumerSources(ownerName, context);
  if (sources.size === 0) return;
  const sourceKey = JSON.stringify(
    [...sources].toSorted(compareCodePointStrings)
  );
  let digest = context.callerProgramDigests.get(sourceKey);
  if (!digest) {
    digest = createHash('sha256')
      .update(
        JSON.stringify(
          [...sources]
            .map((source) =>
              artifactOwnerCallerSourceRecord(
                source,
                context,
                moduleSourceReplacement
              )
            )
            .toSorted((left, right) =>
              compareCodePointStrings(left.source, right.source)
            )
        )
      )
      .digest('hex');
    context.callerProgramDigests.set(sourceKey, digest);
  }
  recordArtifactOwnerMutationDigest(
    context.mutationsByOwner,
    ownerName,
    digest,
    `caller:${sourceKey}`
  );
};

const recordArtifactOwnerImportConsumerPrograms = (
  context,
  moduleSourceReplacement
) => {
  context.owners.forEach((_owner, ownerName) =>
    recordArtifactOwnerImportConsumerProgram(
      ownerName,
      context,
      moduleSourceReplacement
    )
  );
};

const artifactOwnerMutationDigestMap = (
  program,
  owners,
  moduleSourceReplacement
) => {
  const mutationsByOwner = new Map();
  const { ranges: dormantRanges } = dormantCloudflareFunctionRanges(program);
  const reachableOwners = new Map();
  const referenceNodes = collectFreeIdentifierReferences(program).nodes;
  const consumerNamesByOwner = new Map();
  const importConsumerNamesByOwner = new Map();
  const unresolvedConsumersByOwner = new Map();
  const ambientAnalysis = artifactOwnerAmbientAnalysis(program, referenceNodes);
  const ownerNamesByReferenceNode = artifactOwnerNamesByReferenceNode(owners);
  const importsByLocalName = staticImportsByLocalName(program);
  const consumerContext = {
    ambientGuards: ambientAnalysis.guards,
    ambientOverrides: ambientAnalysis.overrides,
    callerInteractionIndex: undefined,
    callerInteractionDigests: new Map(),
    callerProgramDigests: new Map(),
    callerSourceRecords: new Map(),
    consumerNamesByOwner,
    importConsumerNamesByOwner,
    importsBySource: undefined,
    lexicalOwnerNamesByBinding: new WeakMap(),
    lexicalBindingsByNode: new WeakMap(),
    lexicalDigests: new WeakMap(),
    lexicalEntriesByScope: new WeakMap(),
    mutationsByOwner,
    ownerNamesByReferenceNode,
    owners,
    parentNodes: createAstParentMap(program),
    program,
    reachableOwners,
    referenceNodes,
    staticImportsByLocalName: importsByLocalName,
    statementDigests: new WeakMap(),
    statementReferences: new WeakMap(),
    unresolvedConsumersByOwner,
  };
  const record = (node, target) => {
    appendArtifactOwnerMutation(
      mutationsByOwner,
      dormantRanges,
      node,
      artifactOwnerMutationNames(
        target,
        owners,
        reachableOwners,
        referenceNodes
      )
    );
  };
  const recordCall = (node) =>
    recordArtifactOwnerConsumerCall(node, consumerContext, dormantRanges);
  new Visitor({
    AssignmentExpression(node) {
      record(node, node.left);
      recordArtifactOwnerValueFlow(
        node,
        node.left,
        node.right,
        consumerContext,
        dormantRanges
      );
    },
    CallExpression: recordCall,
    ForInStatement(node) {
      record(node, node.left);
    },
    ForOfStatement(node) {
      record(node, node.left);
      recordArtifactOwnerValueFlow(
        node,
        node.left,
        node.right,
        consumerContext,
        dormantRanges
      );
    },
    NewExpression: recordCall,
    TaggedTemplateExpression: recordCall,
    ThrowStatement(node) {
      recordArtifactOwnerThrowFlow(node, consumerContext, dormantRanges);
    },
    UpdateExpression(node) {
      record(node, node.argument);
    },
  }).visit(program);
  recordArtifactOwnerAmbientProvenances(consumerContext);
  recordArtifactOwnerImportConsumerPrograms(
    consumerContext,
    moduleSourceReplacement
  );
  for (const [ownerName, mutations] of mutationsByOwner) {
    mutationsByOwner.set(
      ownerName,
      [...mutations.values()].toSorted(compareCodePointStrings)
    );
  }
  return {
    consumerNamesByOwner,
    importConsumerNamesByOwner,
    mutationsByOwner,
    staticImportsByLocalName: importsByLocalName,
    unresolvedConsumersByOwner,
  };
};

const serializeArtifactOwnerAnalysis = (analysis) => ({
  consumerNamesByOwner: [...analysis.consumerNamesByOwner].map(
    ([name, values]) => [name, [...values]]
  ),
  importConsumerNamesByOwner: [...analysis.importConsumerNamesByOwner].map(
    ([name, values]) => [name, [...values]]
  ),
  mutationsByOwner: [...analysis.mutationsByOwner],
  staticImportsByLocalName: [...analysis.staticImportsByLocalName],
  unresolvedConsumersByOwner: [...analysis.unresolvedConsumersByOwner].map(
    ([name, nodes]) => [
      name,
      nodes.map((node) => ({
        end: node.end,
        start: node.start,
        type: nodeType(node),
      })),
    ]
  ),
});

const deserializeArtifactOwnerAnalysis = (analysis) => ({
  consumerNamesByOwner: new Map(
    analysis.consumerNamesByOwner.map(([name, values]) => [
      name,
      new Set(values),
    ])
  ),
  importConsumerNamesByOwner: new Map(
    analysis.importConsumerNamesByOwner.map(([name, values]) => [
      name,
      new Set(values),
    ])
  ),
  mutationsByOwner: new Map(analysis.mutationsByOwner),
  staticImportsByLocalName: new Map(analysis.staticImportsByLocalName),
  unresolvedConsumersByOwner: new Map(analysis.unresolvedConsumersByOwner),
});

const createArtifactOwnerModuleAnalysis = (
  context,
  chunkFile,
  manifestRecord,
  program,
  owners
) =>
  artifactOwnerMutationDigestMap(program, owners, (source, kind) =>
    artifactOwnerModuleSource(
      source,
      kind,
      chunkFile,
      manifestRecord,
      (linkedFile) => artifactOwnerManifestRecordFor(context, linkedFile),
      context.message
    )
  );

const authenticatedCloudflareSourceFor = (chunkFile, message) => {
  const authenticated = authenticatedCloudflareModuleSources.get(
    path.resolve(chunkFile)
  );
  assert(authenticated, message);
  return authenticated;
};

const verifiedCloudflareMetadataFor = (filePath, message) => {
  const verified = verifiedCloudflareMetadataSources.get(
    fs.realpathSync(filePath)
  );
  assert(verified, message);
  return verified;
};

const runArtifactOwnerModuleAnalysis = (artifactRoot, chunkFile) => {
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    chunkFile,
    'artifact owner analysis'
  );
  cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord);
  const rootRecord = { ...manifestRecord, chunkFile };
  const context = createArtifactOwnerTraversal(
    rootRecord,
    '__artifact_owner_analysis__',
    `${chunkFile} artifact owner analysis`
  );
  const authenticated = authenticatedCloudflareSourceFor(
    chunkFile,
    `${chunkFile} artifact owner authenticated source`
  );
  const source = authenticated.source;
  const program = parseModuleSource(chunkFile, source).program;
  const owners = uniqueTopLevelOwners(program, context.message);
  const result = {
    analysis: serializeArtifactOwnerAnalysis(
      createArtifactOwnerModuleAnalysis(
        context,
        chunkFile,
        rootRecord,
        program,
        owners
      )
    ),
    integrity: {
      manifestSha256: verifiedCloudflareMetadataFor(
        manifestRecord.manifestFile,
        context.message
      ).sha256,
      sourceSha256: authenticated.sha256,
    },
  };
  assertAuthenticatedCloudflareSourcesUnchanged();
  assertVerifiedCloudflareMetadataUnchanged();
  return result;
};

const readIsolatedArtifactOwnerAnalysis = (context, chunkFile) => {
  const manifestRecord = artifactOwnerManifestRecordFor(context, chunkFile);
  cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord);
  const authenticated = authenticatedCloudflareSourceFor(
    chunkFile,
    context.message
  );
  const verifiedManifest = verifiedCloudflareMetadataFor(
    manifestRecord.manifestFile,
    context.message
  );
  const output = execFileSync(
    process.execPath,
    [
      '--max-old-space-size=2048',
      runtimeProfileVerifierFile,
      '--artifact-owner-analysis',
      context.rootRecord.artifactRoot,
      chunkFile,
    ],
    {
      encoding: 'utf8',
      env: activeCloudflareAppChunkProvenanceKey
        ? {
            [cloudflareAppChunkProvenanceKeyEnvironment]:
              activeCloudflareAppChunkProvenanceKey,
          }
        : {},
      killSignal: 'SIGKILL',
      maxBuffer: 32 * 1_024 * 1_024,
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 30_000,
    }
  );
  const result = JSON.parse(output);
  const message = `${chunkFile} isolated artifact owner analysis integrity`;
  assert(isObjectRecord(result) && isObjectRecord(result.integrity), message);
  const expectedManifestDigest = verifiedManifest.sha256;
  assert(result.integrity.sourceSha256 === authenticated.sha256, message);
  assert(result.integrity.manifestSha256 === expectedManifestDigest, message);
  return {
    analysis: deserializeArtifactOwnerAnalysis(result.analysis),
    source: Buffer.from(authenticated.source),
  };
};

const artifactOwnerEntrypointKey = ({ chunkFile, localName }) =>
  `${chunkFile}\0${localName}`;

const createArtifactOwnerTraversal = (rootRecord, initialName, message) => {
  const initialEntrypoint = {
    chunkFile: rootRecord.chunkFile,
    enforceConsumerResolution: true,
    localName: initialName,
  };
  return {
    identityFiles: new Map(),
    importEdges: new Set(),
    importEvidenceByFile: new Map(),
    initialName,
    manifestByFile: new Map(
      Object.entries(rootRecord.manifest).map(([key, entry]) => [
        entry.file,
        { ...rootRecord, entry, key },
      ])
    ),
    message,
    namespaceDigestNodes: new Map(),
    ownerRecords: new Map(),
    pending: [initialEntrypoint],
    processedEntrypoints: new Map(),
    queuedEntrypoints: new Map([
      [artifactOwnerEntrypointKey(initialEntrypoint), true],
    ]),
    rootRecord,
    states: new Map(),
  };
};

const maximumArtifactOwnerCachedStates = 1;

const artifactOwnerManifestRecordFor = (context, chunkFile) => {
  assert(
    isWithinDirectory(chunkFile, context.rootRecord.artifactRoot),
    context.message
  );
  assertFile(chunkFile);
  assert(
    isWithinDirectory(
      fs.realpathSync(chunkFile),
      fs.realpathSync(context.rootRecord.artifactRoot)
    ),
    context.message
  );
  const artifactFile = normalizeArtifactFile(
    context.rootRecord.artifactRoot,
    chunkFile
  );
  const record = context.manifestByFile.get(artifactFile);
  assert(record, context.message);
  return { ...record, chunkFile };
};

const registerArtifactOwnerManifestIdentity = (context, manifestRecord) => {
  const identity = manifestRecordNodeIdentity(
    manifestRecord,
    manifestRecord.key,
    context.message
  );
  const identityFile = context.identityFiles.get(identity);
  assert(
    !identityFile || identityFile === manifestRecord.chunkFile,
    `${context.message}: manifest identity ${identity} maps to both ${String(
      identityFile
    )} and ${manifestRecord.chunkFile}`
  );
  context.identityFiles.set(identity, manifestRecord.chunkFile);
  return identity;
};

const artifactOwnerImportEvidenceFor = (context, chunkFile, program) => {
  const existing = context.importEvidenceByFile.get(chunkFile);
  if (existing) return existing;
  const evidence = {
    importRanges: cloudflareDynamicImportNodes(program)
      .filter((sourceNode) => literalString(sourceNode.source) === undefined)
      .map((sourceNode) => [sourceNode.start, sourceNode.end]),
    reviewedOwnerRanges: [],
  };
  context.importEvidenceByFile.set(chunkFile, evidence);
  return evidence;
};

const cacheArtifactOwnerState = (context, chunkFile, state) => {
  context.states.set(chunkFile, state);
  while (context.states.size > maximumArtifactOwnerCachedStates) {
    context.states.delete(context.states.keys().next().value);
  }
  return state;
};

const touchArtifactOwnerState = (context, chunkFile, state) => {
  context.states.delete(chunkFile);
  context.states.set(chunkFile, state);
  return state;
};

const readArtifactOwnerParsedModule = (chunkFile, isolatedResult) => {
  if (!isolatedResult) return readParsedModule(chunkFile);
  return parseModuleSource(chunkFile, isolatedResult.source.toString('utf8'));
};

const readArtifactOwnerAnalysis = (
  context,
  chunkFile,
  manifestRecord,
  program,
  owners,
  isolatedResult
) => {
  if (isolatedResult) return isolatedResult.analysis;
  return createArtifactOwnerModuleAnalysis(
    context,
    chunkFile,
    manifestRecord,
    program,
    owners
  );
};

const readArtifactOwnerModuleState = (context, chunkFile, manifestRecord) => {
  const isolateAnalysis =
    fs.statSync(chunkFile).size >= maximumCachedParsedModuleBytes;
  const isolatedResult = isolateAnalysis
    ? readIsolatedArtifactOwnerAnalysis(context, chunkFile)
    : undefined;
  const parsedModule = readArtifactOwnerParsedModule(chunkFile, isolatedResult);
  const program = parsedModule.program;
  const owners = uniqueTopLevelOwners(program, context.message);
  const ownerAnalysis = readArtifactOwnerAnalysis(
    context,
    chunkFile,
    manifestRecord,
    program,
    owners,
    isolatedResult
  );
  return { ownerAnalysis, owners, program };
};

const artifactOwnerStateFor = (context, chunkFile) => {
  const existing = context.states.get(chunkFile);
  if (existing) return touchArtifactOwnerState(context, chunkFile, existing);
  const manifestRecord = artifactOwnerManifestRecordFor(context, chunkFile);
  registerArtifactOwnerManifestIdentity(context, manifestRecord);
  const { ownerAnalysis, owners, program } = readArtifactOwnerModuleState(
    context,
    chunkFile,
    manifestRecord
  );
  const importEvidence = artifactOwnerImportEvidenceFor(
    context,
    chunkFile,
    program
  );
  const state = {
    chunkFile,
    consumerNamesByOwner: ownerAnalysis.consumerNamesByOwner,
    importConsumerNamesByOwner: ownerAnalysis.importConsumerNamesByOwner,
    manifestRecord,
    mutationDigests: ownerAnalysis.mutationsByOwner,
    owners,
    program,
    reviewedOwnerRanges: importEvidence.reviewedOwnerRanges,
    staticImportsByLocalName: ownerAnalysis.staticImportsByLocalName,
    unresolvedConsumersByOwner: ownerAnalysis.unresolvedConsumersByOwner,
  };
  return cacheArtifactOwnerState(context, chunkFile, state);
};

const addArtifactOwnerExternalEdge = (
  context,
  ownerId,
  reference,
  imported
) => {
  assert(
    reviewedCloudflareClosureExternals.has(imported.source),
    context.message
  );
  context.importEdges.add(
    JSON.stringify([
      ownerId,
      reference,
      `external:${imported.source}:${imported.importedName}`,
    ])
  );
};

const artifactOwnerNamespaceDependencyKeys = (
  context,
  manifestRecord,
  program
) => {
  const manifestKeys = [
    ...(manifestRecord.entry.imports ?? []),
    ...(manifestRecord.entry.dynamicImports ?? []),
  ];
  assert(isStringArray(manifestKeys), context.message);
  const sourceKeys = [
    ...cloudflareStaticDependencySources(program),
    ...cloudflareDynamicImportSources(program).filter(Boolean),
  ].flatMap((source) => {
    if (!source.startsWith('.')) {
      assert(reviewedCloudflareClosureExternals.has(source), context.message);
      return [];
    }
    const linkedFile = path.resolve(
      path.dirname(manifestRecord.chunkFile),
      source
    );
    return [artifactOwnerManifestRecordFor(context, linkedFile).key];
  });
  return new Set([...manifestKeys, ...sourceKeys]);
};

const artifactOwnerNamespaceDigestNode = (context, manifestRecord) => {
  const cached = context.namespaceDigestNodes.get(manifestRecord.key);
  if (cached) return cached;
  const id = registerArtifactOwnerManifestIdentity(context, manifestRecord);
  const program = readNamespaceParsedModule(manifestRecord.chunkFile).program;
  const dependencyKeys = artifactOwnerNamespaceDependencyKeys(
    context,
    manifestRecord,
    program
  );
  const result = {
    dependencyKeys,
    node: {
      astDigest:
        manifestRecord.entry.src === 'tanstack-start-manifest:v'
          ? tanStackManifestProgramDigest(program)
          : astDigest(program, (source, kind) =>
              artifactOwnerModuleSource(
                source,
                kind,
                manifestRecord.chunkFile,
                manifestRecord,
                (linkedFile) =>
                  artifactOwnerManifestRecordFor(context, linkedFile),
                context.message
              )
            ),
      edges: [...dependencyKeys]
        .map((dependencyKey) =>
          manifestRecordNodeIdentity(
            context.rootRecord,
            dependencyKey,
            context.message
          )
        )
        .toSorted(compareCodePointStrings),
      id,
    },
  };
  context.namespaceDigestNodes.set(manifestRecord.key, result);
  return result;
};

const artifactOwnerNamespaceClosureDigest = (context, initialRecord) => {
  const nodes = [];
  cloudflareBoundedModuleGraph(initialRecord.key, (key) => {
    const entry = context.rootRecord.manifest[key];
    assert(entry && typeof entry.file === 'string', context.message);
    const chunkFile = path.resolve(context.rootRecord.artifactRoot, entry.file);
    const manifestRecord = artifactOwnerManifestRecordFor(context, chunkFile);
    const { dependencyKeys, node } = artifactOwnerNamespaceDigestNode(
      context,
      manifestRecord
    );
    nodes.push(node);
    return [...dependencyKeys].filter(
      (dependencyKey) =>
        !isAppOwnedCloudflareManifestKey(dependencyKey, context.rootRecord)
    );
  });
  return createHash('sha256')
    .update(
      JSON.stringify(
        nodes.toSorted((left, right) =>
          compareCodePointStrings(left.id, right.id)
        )
      )
    )
    .digest('hex');
};

const addArtifactOwnerNamespaceEdge = (
  context,
  ownerId,
  reference,
  targetRecord
) => {
  const targetId = `${manifestRecordNodeIdentity(
    targetRecord,
    targetRecord.key,
    context.message
  )}#*`;
  if (!context.ownerRecords.has(targetId)) {
    context.ownerRecords.set(targetId, [
      targetId,
      'namespace',
      artifactOwnerNamespaceClosureDigest(context, targetRecord),
      [],
    ]);
  }
  context.importEdges.add(JSON.stringify([ownerId, reference, targetId]));
};

const addArtifactOwnerAppBoundaryEdge = (
  context,
  ownerId,
  reference,
  targetRecord,
  importedName
) => {
  const targetId = `app-owned:${manifestRecordNodeIdentity(
    targetRecord,
    targetRecord.key,
    context.message
  )}#${importedName}`;
  context.importEdges.add(JSON.stringify([ownerId, reference, targetId]));
};

const artifactOwnerInternalTarget = (
  context,
  state,
  source,
  dependencyKind
) => {
  const targetFile = path.resolve(path.dirname(state.chunkFile), source);
  const targetRecord = artifactOwnerManifestRecordFor(context, targetFile);
  const dependencyKeys = state.manifestRecord.entry[dependencyKind] ?? [];
  assert(isStringArray(dependencyKeys), context.message);
  assert(dependencyKeys.includes(targetRecord.key), context.message);
  return { targetFile, targetRecord };
};

const addArtifactOwnerInternalEdge = (
  context,
  state,
  ownerId,
  reference,
  imported
) => {
  const { targetRecord } = artifactOwnerInternalTarget(
    context,
    state,
    imported.source,
    'imports'
  );
  if (isAppOwnedCloudflareManifestKey(targetRecord.key, targetRecord)) {
    addArtifactOwnerAppBoundaryEdge(
      context,
      ownerId,
      reference,
      targetRecord,
      imported.importedName
    );
    return;
  }
  addArtifactOwnerNamespaceEdge(context, ownerId, reference, targetRecord);
};

const addArtifactOwnerDynamicInternalEdge = (
  context,
  state,
  ownerId,
  source
) => {
  const { targetFile, targetRecord } = artifactOwnerInternalTarget(
    context,
    state,
    source,
    'dynamicImports'
  );
  if (isAppOwnedCloudflareManifestKey(targetRecord.key, targetRecord)) {
    addArtifactOwnerAppBoundaryEdge(
      context,
      ownerId,
      'dynamic',
      targetRecord,
      'dynamic'
    );
    return;
  }
  const targetId = `${manifestRecordNodeIdentity(
    targetRecord,
    targetRecord.key,
    context.message
  )}#dynamic`;
  if (!context.ownerRecords.has(targetId)) {
    context.ownerRecords.set(targetId, [
      targetId,
      'dynamic',
      cloudflareStaticImportClosureDigest(
        targetFile,
        targetRecord,
        context.message
      ),
      [],
    ]);
  }
  context.importEdges.add(JSON.stringify([ownerId, 'dynamic', targetId]));
};

const recordArtifactOwnerDynamicImports = (
  context,
  state,
  ownerId,
  ownerNode
) => {
  for (const source of cloudflareDynamicImportSources(ownerNode)) {
    if (source === undefined) {
      context.importEdges.add(
        JSON.stringify([
          ownerId,
          'runtime:nonliteral',
          'dynamic:runtime:nonliteral',
        ])
      );
      continue;
    }
    if (!source.startsWith('.')) {
      assert(reviewedCloudflareClosureExternals.has(source), context.message);
      context.importEdges.add(
        JSON.stringify([ownerId, source, `dynamic:external:${source}`])
      );
      continue;
    }
    addArtifactOwnerDynamicInternalEdge(context, state, ownerId, source);
  }
};

const addArtifactOwnerImportEdge = (
  context,
  state,
  ownerId,
  reference,
  imported
) => {
  if (!imported.source?.startsWith('.')) {
    addArtifactOwnerExternalEdge(context, ownerId, reference, imported);
    return;
  }
  addArtifactOwnerInternalEdge(context, state, ownerId, reference, imported);
};

const addArtifactOwnerConsumerImportEdge = (
  context,
  state,
  ownerId,
  reference,
  imported
) => {
  if (!imported.source?.startsWith('.')) {
    addArtifactOwnerExternalEdge(context, ownerId, reference, imported);
    return;
  }
  addArtifactOwnerInternalEdge(context, state, ownerId, reference, imported);
};

const recordArtifactOwnerReference = (context, state, ownerId, reference) => {
  if (state.owners.has(reference)) return;
  const imported = state.staticImportsByLocalName.get(reference);
  if (!imported) return;
  addArtifactOwnerImportEdge(context, state, ownerId, reference, imported);
};

const recordArtifactOwnerConsumerReference = (
  context,
  state,
  ownerId,
  reference
) => {
  const imported = state.staticImportsByLocalName.get(reference);
  assert(imported, context.message);
  addArtifactOwnerConsumerImportEdge(
    context,
    state,
    ownerId,
    reference,
    imported
  );
};

const recordArtifactOwnerRange = (state, ownerNode) => {
  if (!ownerNode) return;
  const range = [ownerNode.start, ownerNode.end];
  if (
    !state.reviewedOwnerRanges.some(
      ([start, end]) => start === range[0] && end === range[1]
    )
  ) {
    state.reviewedOwnerRanges.push(range);
  }
};

const artifactOwnerRelationReferences = (ownerNode) =>
  new Set(freeIdentifierNames(ownerNode));

const recordArtifactOwnerConsumerReferences = (context, state, name, ownerId) =>
  (state.importConsumerNamesByOwner.get(name) ?? []).forEach((reference) =>
    recordArtifactOwnerConsumerReference(context, state, ownerId, reference)
  );

const recordArtifactOwnerRelations = (
  context,
  state,
  name,
  ownerId,
  ownerNode
) => {
  recordArtifactOwnerDynamicImports(context, state, ownerId, ownerNode);
  artifactOwnerRelationReferences(ownerNode).forEach((reference) =>
    recordArtifactOwnerReference(context, state, ownerId, reference)
  );
  recordArtifactOwnerConsumerReferences(context, state, name, ownerId);
};

const recordArtifactOwner = (context, state, chunkIdentity, name) => {
  const ownerId = `${chunkIdentity}#${name}`;
  if (context.ownerRecords.has(ownerId)) return;
  const owner = state.owners.get(name);
  const ownerNode = topLevelOwnerReferenceNode(owner);
  const mutationDigests = state.mutationDigests.get(name) ?? [];
  recordArtifactOwnerRange(state, ownerNode);
  context.ownerRecords.set(ownerId, [
    ownerId,
    owner.kind,
    astDigest(owner.node, (source, kind) =>
      artifactOwnerModuleSource(
        source,
        kind,
        state.chunkFile,
        state.manifestRecord,
        (chunkFile) => artifactOwnerManifestRecordFor(context, chunkFile),
        context.message
      )
    ),
    mutationDigests,
  ]);
  recordArtifactOwnerRelations(context, state, name, ownerId, ownerNode);
};

const assertReviewedArtifactOwnerImport = (
  reviewedOwnerRanges,
  importRange,
  message
) => {
  const [start, end] = importRange;
  assert(isInsideNestedFunction({ start, end }, reviewedOwnerRanges), message);
};

const assertReviewedArtifactOwnerStateImports = (evidence, message) => {
  if (evidence.reviewedOwnerRanges.length === 0) return;
  evidence.importRanges.forEach((importRange) =>
    assertReviewedArtifactOwnerImport(
      evidence.reviewedOwnerRanges,
      importRange,
      message
    )
  );
};

const assertReviewedArtifactOwnerNonliteralImports = (context) =>
  context.importEvidenceByFile.forEach((evidence) =>
    assertReviewedArtifactOwnerStateImports(evidence, context.message)
  );

const artifactOwnerEntrypointAlreadyProcessed = (context, current) => {
  const key = artifactOwnerEntrypointKey(current);
  const previous = context.processedEntrypoints.get(key);
  if (previous === true || previous === current.enforceConsumerResolution) {
    return true;
  }
  context.processedEntrypoints.set(key, current.enforceConsumerResolution);
  return false;
};

const visitArtifactOwner = (context, current) => {
  if (artifactOwnerEntrypointAlreadyProcessed(context, current)) return;
  const state = artifactOwnerStateFor(context, current.chunkFile);
  assert(state.owners.has(current.localName), context.message);
  const reachable = reachableTopLevelOwners(state.owners, current.localName, {
    consumerNamesByOwner: state.consumerNamesByOwner,
    enforceConsumerResolution: current.enforceConsumerResolution,
    message: `${context.message} at ${state.chunkFile}`,
    unresolvedConsumersByOwner: state.unresolvedConsumersByOwner,
  });
  const chunkIdentity = manifestRecordNodeIdentity(
    state.manifestRecord,
    state.manifestRecord.key,
    context.message
  );
  for (const name of reachable) {
    recordArtifactOwner(context, state, chunkIdentity, name);
  }
};

const drainArtifactOwnerTraversal = (context) => {
  while (context.pending.length > 0) {
    const current = context.pending.pop();
    const key = artifactOwnerEntrypointKey(current);
    if (
      context.queuedEntrypoints.get(key) !== current.enforceConsumerResolution
    ) {
      continue;
    }
    context.queuedEntrypoints.delete(key);
    visitArtifactOwner(context, current);
  }
};

const updateHashWithJsonArray = (hash, values) => {
  hash.update('[');
  values.forEach((value, index) => {
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(value));
  });
  hash.update(']');
};

const releaseArtifactOwnerAnalysis = (context) => {
  context.importEvidenceByFile.clear();
  context.namespaceDigestNodes.clear();
  context.processedEntrypoints.clear();
  context.queuedEntrypoints.clear();
  context.states.clear();
};

const artifactOwnerClosureDigest = (rootRecord, initialName, message) => {
  const context = createArtifactOwnerTraversal(
    rootRecord,
    initialName,
    message
  );
  drainArtifactOwnerTraversal(context);
  assertReviewedArtifactOwnerNonliteralImports(context);
  const rootIdentity = manifestRecordNodeIdentity(
    rootRecord,
    rootRecord.key,
    message
  );
  const reviewRecord = {
    edges: [...context.importEdges].toSorted(compareCodePointStrings),
    owners: [...context.ownerRecords.values()].toSorted(([left], [right]) =>
      compareCodePointStrings(left, right)
    ),
    root: `${rootIdentity}#${initialName}`,
    version: 1,
  };
  releaseArtifactOwnerAnalysis(context);
  const hash = createHash('sha256');
  hash.update('{"edges":');
  updateHashWithJsonArray(hash, reviewRecord.edges);
  hash.update(',"owners":');
  updateHashWithJsonArray(hash, reviewRecord.owners);
  hash.update(',"root":');
  hash.update(JSON.stringify(reviewRecord.root));
  hash.update(',"version":1}');
  return hash.digest('hex');
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

const defaultExportBindingName = (declaration) => {
  const directName = identifierName(declaration);
  if (directName) return directName;
  return identifierName(declaration.id);
};

const defaultExportBindingEntries = (statement) => {
  if (statement.type !== 'ExportDefaultDeclaration') return [];
  const localName = defaultExportBindingName(statement.declaration);
  return localName ? [['default', localName]] : [];
};

const moduleExportEntries = (statement) => [
  ...namedExportEntries(statement),
  ...defaultExportBindingEntries(statement),
];

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
  let work = 0;
  while (pending.length > 0) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    const functionNode = functions.get(name);
    if (!functionNode) continue;
    visited.add(name);
    work += 1;
    const { calls } = inspectFunction(functionNode);
    const callees = [...calls.values()].filter((call) => functions.has(call));
    assert(
      work + pending.length + callees.length <= cloudflareAnalysisWorkLimit,
      cloudflareAnalysisWorkMessage
    );
    callees.forEach((callee) => pending.push(callee));
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

const artifactTreeEntries = (directoryPath) =>
  fs.readdirSync(directoryPath, { recursive: true, withFileTypes: true });

const assertRegularArtifactTree = (directoryPath, repositoryRoot) => {
  const rootMetadata = fs.lstatSync(directoryPath);
  assert(
    rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    `${directoryPath} must be a regular artifact directory`
  );
  assert(
    isWithinDirectory(
      fs.realpathSync(directoryPath),
      fs.realpathSync(repositoryRoot)
    ),
    `${directoryPath} must remain inside its repository`
  );
  for (const entry of artifactTreeEntries(directoryPath)) {
    assert(
      entry.isDirectory() || entry.isFile(),
      `${path.join(entry.parentPath, entry.name)} must be a regular artifact entry`
    );
  }
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

const assertNoArtifactTokens = (directoryPath, tokens) => {
  const files = findFilesNamedLike(directoryPath, (name) =>
    /\.(?:cjs|css|html|js|json|mjs)$/u.test(name)
  );
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const token of tokens) {
      assert(!source.includes(token), `${filePath} contains ${token}`);
    }
  }
};

const assertNoArtifactSecrets = (directoryPath, secrets) => {
  const encodedSecrets = secrets.map((secret) => Buffer.from(secret));
  if (encodedSecrets.length === 0) return;
  artifactTreeEntries(directoryPath).forEach((entry) =>
    assertArtifactEntryContainsNoSecrets(entry, encodedSecrets)
  );
};

const assertArtifactEntryContainsNoSecrets = (entry, encodedSecrets) => {
  if (!entry.isFile()) return;
  const filePath = path.join(entry.parentPath, entry.name);
  const content = fs.readFileSync(filePath);
  encodedSecrets.forEach((secret) =>
    assert(!content.includes(secret), `${filePath} contains a build secret`)
  );
};

const assertCloudflareHyperdriveBinding = (sourceConfig, generatedConfig) => {
  assert(
    Array.isArray(sourceConfig.hyperdrive),
    'Cloudflare source Hyperdrive bindings'
  );
  assert(
    sourceConfig.hyperdrive.length === 1,
    'Cloudflare source must declare one Hyperdrive binding'
  );
  const [sourceBinding] = sourceConfig.hyperdrive;
  assert(
    sourceBinding.binding === 'START_UI_DATABASE',
    'Cloudflare source START_UI_DATABASE Hyperdrive binding'
  );
  assert(
    typeof sourceBinding.id === 'string',
    'Cloudflare source Hyperdrive configuration ID'
  );
  assert(
    sourceBinding.id.length > 0,
    'Cloudflare source Hyperdrive configuration ID'
  );

  assert(
    Array.isArray(generatedConfig.hyperdrive),
    'Cloudflare generated Hyperdrive bindings'
  );
  assert(
    generatedConfig.hyperdrive.length === 1,
    'Cloudflare generated Hyperdrive binding count'
  );
  const [generatedBinding] = generatedConfig.hyperdrive;
  assert(
    generatedBinding.binding === sourceBinding.binding,
    'Cloudflare generated Hyperdrive binding name'
  );
  assert(
    generatedBinding.id === sourceBinding.id,
    'Cloudflare generated Hyperdrive configuration ID'
  );
};

const runtimeArtifactOutput = (profile, root) => {
  if (profile === 'node') return path.join(root, '.output/node');
  if (profile === 'vercel') return path.join(root, '.vercel/output');
  return path.join(root, 'dist');
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

const authenticateCloudflareArtifactBeforeParsing = (serverEntry) => {
  const artifactRoot = path.dirname(serverEntry);
  const manifestRecord = assertCloudflareChunkManifestMembership(
    artifactRoot,
    serverEntry,
    'authenticated Worker entry'
  );
  cloudflareManifestChunkRecord(manifestRecord.key, manifestRecord);
  assertAuthenticatedCloudflareSourcesUnchanged();
  assertVerifiedCloudflareMetadataUnchanged();
};

const verifyCloudflare = (root, expectedAppSlug, tanStackOwnerDigests) => {
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
  assertCloudflareHyperdriveBinding(sourceConfig, generatedConfig);
  assert(
    findFilesNamedLike(
      output,
      (name) => name === '.dev.vars' || name.startsWith('.dev.vars.')
    ).length === 0,
    'Cloudflare production output must not contain .dev.vars files'
  );
  assertDirectory(path.join(output, 'client'));
  const serverEntry = path.join(output, 'server/index.js');
  authenticateCloudflareArtifactBeforeParsing(serverEntry);
  assertOnlyProfileMarker(serverEntry, 'cloudflare');
  assertCloudflareDatabaseOwner(serverEntry, tanStackOwnerDigests);
  assertCloudflareShallowReviewCoverage();
  assertRequiredRuntimeTokens(path.join(output, 'server'), 'cloudflare');
  assertNoForbiddenRuntimeTokens(path.join(output, 'server'), 'cloudflare');
};

export const verifyRuntimeProfile = (
  profile,
  root = process.cwd(),
  {
    cloudflareAppChunkProvenanceKey,
    cloudflareTanStackOwnerDigests,
    expectedAppSlug = process.env.APP_SLUG,
    forbiddenArtifactSecrets = [],
    forbiddenBuildTokens = [],
  } = {}
) => {
  clearParsedModuleCaches();
  authenticatedCloudflareModuleSources.clear();
  verifiedCloudflareMetadataSources.clear();
  cloudflareAppChunkProvenanceCache.clear();
  reviewedCloudflareOutputFiles.clear();
  shallowScannedCloudflareOutputFiles.clear();
  shallowScannedCloudflareOutputQueue.length = 0;
  activeCloudflareAppChunkProvenanceKey =
    cloudflareAppChunkProvenanceKey ??
    process.env[cloudflareAppChunkProvenanceKeyEnvironment];
  try {
    assert(profiles.has(profile), `unknown profile ${String(profile)}`);
    if (profile === 'cloudflare') {
      assertCloudflareAppChunkProvenanceKey(
        activeCloudflareAppChunkProvenanceKey
      );
    }
    const output = runtimeArtifactOutput(profile, root);
    assertRegularArtifactTree(output, root);
    if (profile === 'node') verifyNode(root);
    else if (profile === 'vercel') verifyVercel(root);
    else
      verifyCloudflare(root, expectedAppSlug, cloudflareTanStackOwnerDigests);
    assertNoArtifactTokens(output, forbiddenBuildTokens);
    assertNoArtifactSecrets(output, forbiddenArtifactSecrets);
    assertAuthenticatedCloudflareSourcesUnchanged();
    assertVerifiedCloudflareMetadataUnchanged();
    return profile;
  } finally {
    activeCloudflareAppChunkProvenanceKey = undefined;
    cloudflareAppChunkProvenanceCache.clear();
    reviewedCloudflareOutputFiles.clear();
    shallowScannedCloudflareOutputFiles.clear();
    shallowScannedCloudflareOutputQueue.length = 0;
    authenticatedCloudflareModuleSources.clear();
    verifiedCloudflareMetadataSources.clear();
    clearParsedModuleCaches();
  }
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    if (process.argv[2] === '--artifact-owner-analysis') {
      activeCloudflareAppChunkProvenanceKey =
        process.env[cloudflareAppChunkProvenanceKeyEnvironment];
      process.stdout.write(
        JSON.stringify(
          runArtifactOwnerModuleAnalysis(process.argv[3], process.argv[4])
        )
      );
    } else {
      const profile = verifyRuntimeProfile(process.argv[2]);
      console.log(`Verified ${profile} runtime artifact contract.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
