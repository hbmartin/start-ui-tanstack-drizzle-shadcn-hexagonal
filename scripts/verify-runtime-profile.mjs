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

const fail = (message) => {
  throw new Error(`Runtime profile verification failed: ${message}`);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const assertConditions = (conditions, message) =>
  assert(conditions.every(Boolean), message);

const nodeType = ({ type } = {}) => type;

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

const propertyKeyName = (property) =>
  property?.type === 'Property'
    ? (identifierName(property.key) ?? literalString(property.key))
    : undefined;

const objectPropertyValue = (objectExpression, key) =>
  objectExpression.properties.find(
    (property) => propertyKeyName(property) === key
  )?.value;

const identifierMemberSignature = ({ type, computed, object, property } = {}) =>
  [type, computed, identifierName(object), identifierName(property)].join(':');

const findDefaultWorkerFetch = (program, filePath) => {
  const exports = new Map(program.body.flatMap(namedExportEntries));
  const defaultLocalName = exports.get('default');
  const declarations = program.body.flatMap((statement) =>
    statement.type === 'VariableDeclaration' ? statement.declarations : []
  );
  const worker = declarations.find(
    (declarator) => identifierName(declarator.id) === defaultLocalName
  )?.init;
  assert(
    worker?.type === 'ObjectExpression',
    `${filePath} must export one default Worker object`
  );
  const fetchFunction = objectPropertyValue(worker, 'fetch');
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

const nestedMemberCallsAnywhere = (node, objectSignature, propertyName) => {
  const calls = [];
  new Visitor({
    CallExpression(call) {
      if (identifierName(call.callee?.property) !== propertyName) return;
      if (identifierMemberSignature(call.callee.object) !== objectSignature)
        return;
      calls.push(call);
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

const directBodyVariableDeclarators = (functionNode, localName) => {
  const statements = Array.isArray(functionNode.body)
    ? functionNode.body
    : functionNode.body.body;
  return statements.flatMap((statement, index) => {
    if (statement.type !== 'VariableDeclaration') return [];
    return statement.declarations
      .filter((declarator) => bindingNames(declarator.id).includes(localName))
      .map((declarator) => ({ declaration: statement, declarator, index }));
  });
};

const topLevelVariableInitializer = (program, localName) =>
  program.body
    .flatMap((statement) =>
      statement.type === 'VariableDeclaration' ? statement.declarations : []
    )
    .find((declarator) => identifierName(declarator.id) === localName)?.init;

const noBindingNames = () => [];
const propertyBindingNames = (property) =>
  bindingNames(property.value ?? property.argument);
const bindingNameReaders = {
  ArrayPattern: (pattern) => pattern.elements.flatMap(bindingNames),
  AssignmentPattern: (pattern) => bindingNames(pattern.left),
  Identifier: (pattern) => [pattern.name],
  ObjectPattern: (pattern) => pattern.properties.flatMap(propertyBindingNames),
  RestElement: (pattern) => bindingNames(pattern.argument),
};
const bindingNames = (pattern) =>
  (bindingNameReaders[pattern?.type] ?? noBindingNames)(pattern);

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
    UpdateExpression(node) {
      addMutationTargetNames(names, node.argument);
    },
  }).visit(functionNode);
  return names;
};

const directAssignments = (functionNode, localName) => {
  const assignments = [];
  new Visitor({
    AssignmentExpression(node) {
      if (mutationRootName(node.left) === localName) assignments.push(node);
    },
  }).visit(functionNode);
  const nestedRanges = nestedFunctionRanges(functionNode);
  return assignments.filter(
    (assignment) => !isInsideNestedFunction(assignment, nestedRanges)
  );
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
  assertCloudflareNativeTelemetryInstall(telemetryScope.block.body, filePath);
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
  const fallbackOwners = topLevelBindingDeclarators(
    program,
    'lastKnownNativeTelemetry'
  );
  assert(
    fallbackOwners.length === 1,
    `${filePath} must declare one native telemetry fallback owner`
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
  for (const exportedName of exportedNames) {
    assertCloudflareChunkLocalOwner(
      program,
      chunkFile,
      exportedName,
      requiredCalls[exportedName],
      requiredIdentifiers[exportedName]
    );
  }
  return { chunkFile, program };
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
    program: chunkProgram,
  } = assertCloudflareNamedOwnerImport(program, filePath, {
    assetPattern: /^\.\/assets\/request-telemetry(?:-[\w-]+)?\.js$/,
    exportedNames: [owner],
    requiredCalls: {
      [owner]: ['createCloudflareSentryOptions', 'setTelemetry'],
    },
  });
  assertCloudflareRequestTelemetryChunkBehavior(chunkProgram, chunkFile);
  assert(
    !hasIdentifierOutsideRanges(program, owner, [
      [fetchFunction.start, fetchFunction.end],
      [declarator.id.start, declarator.id.end],
    ]),
    `${filePath} must not alias trusted owner ${owner}`
  );
};

const assertCloudflareApplicationLoader = (loader, filePath) => {
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
  const importedOwners = directBodyVariableDeclarators(
    loader,
    'createApplicationServerEntry'
  );
  assert(
    importedOwners.length === 1,
    `${filePath} must import one trusted application server-entry owner`
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
  assertCloudflareApplicationChunkProvenance(applicationChunk, filePath);
  assert(
    !mutatedNames(loader).has('createApplicationServerEntry'),
    `${filePath} must not mutate its application server-entry owner`
  );
  const calls = directNamedCalls(loader, 'createApplicationServerEntry');
  assert(
    calls.length === 1,
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
    nodeRangeSignature(unwrapAwaitExpression(returns[0].argument)) ===
      nodeRangeSignature(calls[0]),
    `${filePath} must return its isolated Cloudflare application`
  );
};

const assertCloudflareApplicationChunkProvenance = (
  applicationChunk,
  entryFile
) => {
  const artifactRoot = path.dirname(entryFile);
  const manifestFile = path.join(artifactRoot, '.vite', 'manifest.json');
  assertFile(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const assetFile = path.relative(artifactRoot, applicationChunk);
  const sources = Object.values(manifest).filter(
    (entry) => entry.file === assetFile
  );
  assert(
    sources.length === 1,
    `${applicationChunk} must have one Vite application provenance record`
  );
  assertConditions(
    [
      sources[0].isDynamicEntry === true,
      sources[0].src === 'src/runtime/create-application-server-entry.ts',
    ],
    `${applicationChunk} must originate from the universal application server entry`
  );
  const { program } = readParsedModule(applicationChunk);
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
    owner.async,
    `${applicationChunk} universal application server entry must be async`
  );
  assert(
    owner.params.map(identifierName).join(':') ===
      'runtimeProfile:lifecycle:requestScope',
    `${applicationChunk} universal application server entry must accept exact owners`
  );
  const createEntries = memberCallsAnywhere(
    owner,
    'MemberExpression:false:tanstack:createServerEntry'
  );
  assert(
    createEntries.length === 1,
    `${applicationChunk} must create one TanStack server entry`
  );
  const frameworkRequests = nestedMemberCallsAnywhere(
    owner,
    'MemberExpression:false:tanstack:default',
    'fetch'
  );
  assert(
    frameworkRequests.length > 0,
    `${applicationChunk} must execute the TanStack application request path`
  );
  for (const [ownerName, sourcePattern] of [
    ['telemetryProxy', /^\.\/telemetry(?:-[\w-]+)?\.js$/],
    ['tanstack', /^\.\/entry-server(?:-[\w-]+)?\.js$/],
  ]) {
    const imports = directBodyVariableDeclarators(owner, ownerName);
    assert(
      imports.length === 1,
      `${applicationChunk} must import trusted ${ownerName} exactly once`
    );
    assert(
      nodeType(imports[0].declarator.init) === 'AwaitExpression',
      `${applicationChunk} must await trusted ${ownerName} import`
    );
    assert(
      sourcePattern.test(dynamicImportSource(imports[0].declarator) ?? ''),
      `${applicationChunk} must import trusted ${ownerName} from its owner chunk`
    );
  }
};

const assertCloudflareApplicationInitializer = (initializer, filePath) => {
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
  assertCloudflareApplicationLoader(initializer.arguments[1], filePath);
};

const assertCloudflareApplicationOwner = (program, filePath) => {
  const ownerNames = ['application', 'sentryRequestIsolationReady'];
  const declarators = ownerNames.map((owner) => {
    const matches = topLevelBindingDeclarators(program, owner);
    assert(
      matches.length === 1,
      `${filePath} must declare trusted owner ${owner} exactly once`
    );
    return matches[0];
  });
  const [declarator] = declarators;
  assert(
    declarators.every((candidate) => candidate === declarator),
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
  assertCloudflareApplicationInitializer(initializer, filePath);
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
  const sdkSources = Object.values(manifest).filter(
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
    owner.params.map(identifierName).join(':') === 'request:waitUntil',
    `${chunkFile} request flush owner must accept the active request lifecycle`
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
  assertExactLocalChunkFunction(
    program,
    chunkFile,
    'bindCloudflareDatabaseToResponse'
  );
  const owner = topLevelVariableInitializer(
    program,
    'runWithCloudflareDatabase'
  );
  assert(
    nodeType(owner) === 'ArrowFunctionExpression',
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
    literalString(validateCall.arguments[0]) === 'cloudflare',
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
};

const assertCloudflareDatabaseConnectFailure = (handler, chunkFile) => {
  assertConditions(
    [
      nodeType(handler) === 'CatchClause',
      identifierName(handler?.param) === 'failure',
      handler?.body.body.length === 2,
    ],
    `${chunkFile} database owner must preserve connection failures`
  );
  const capture = handler.body.body[0].expression;
  assertConditions(
    [
      nodeType(capture) === 'CallExpression',
      identifierName(capture.callee) === 'captureDatabaseConnectionFailure',
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
      identifierName(close.argument?.callee) === 'closeDatabase',
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

const assertCloudflareTelemetrySuccess = (scope, chunkFile) => {
  assert(
    scope.block.body.length === 4,
    `${chunkFile} request telemetry owner must configure one Sentry adapter chain`
  );
  const options = directBodyVariableDeclarators(scope.block, 'sentryOptions');
  assert(
    options.length === 1,
    `${chunkFile} request telemetry owner must create one Sentry options value`
  );
  assert(
    options[0].index === 0,
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
  assert(
    adapters[0].index === 1,
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
  const installStatement = scope.block.body[2];
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
  const successReturn = scope.block.body[3];
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
    shorthandBindingSignature({ id: owner.params[0] }) ===
      expectedShorthandBindingSignature([
        'environment',
        'nativeTelemetry',
        'request',
        'sentry',
        'sentryRequestIsolationReady',
      ]),
    `${chunkFile} request telemetry owner must accept exact active inputs`
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
    owner.params.map(identifierName).join(':') === 'api',
    `${chunkFile} must define Sentry async-context isolation for the active API`
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
    owner.params.map(identifierName).join(':') === 'api:loadApplication',
    `${chunkFile} Sentry application owner must accept exact initialization inputs`
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
  const initialize = readiness[0].declarator.init;
  assert(
    nodeType(initialize) === 'CallExpression',
    `${chunkFile} Sentry application owner must initialize the active SDK isolation`
  );
  assertConditions(
    [
      identifierName(initialize.callee) ===
        'initializeCloudflareSentryIsolation',
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

const assertCloudflareSentryRequestChunkOwner = (program, chunkFile) => {
  const owner = topLevelVariableInitializer(program, 'runWithCloudflareSentry');
  assert(
    shorthandBindingSignature({ id: owner.params[0] }) ===
      expectedShorthandBindingSignature([
        'api',
        'handle',
        'request',
        'requestOptions',
      ]),
    `${chunkFile} Sentry request owner must accept exact active request inputs`
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
  const runners = directBodyVariableDeclarators(owner, 'runApplicationOnce');
  assert(
    runners.length === 1,
    `${chunkFile} Sentry request owner must define one application execution owner`
  );
  assert(
    runners[0].index === 2,
    `${chunkFile} Sentry request owner must define its runner before request wrapping`
  );
  const runApplicationOnce = runners[0].declarator.init;
  assert(
    nodeType(runApplicationOnce) === 'ArrowFunctionExpression',
    `${chunkFile} Sentry request owner must define one application execution owner`
  );
  assertCloudflareApplicationRunner(runApplicationOnce, chunkFile);
  const requestScope = owner.body.body[3];
  assert(
    nodeType(requestScope) === 'TryStatement',
    `${chunkFile} Sentry request owner must directly enter one SDK request scope`
  );
  assert(
    requestScope.block.body.length > 0,
    `${chunkFile} Sentry request owner must execute its SDK request scope`
  );
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
  const wrapperStatement = requestScope.block.body[0];
  assert(
    withScope[0].start >= wrapperStatement.start,
    `${chunkFile} Sentry request owner must enter SDK isolation directly`
  );
  assert(
    withScope[0].end <= wrapperStatement.end,
    `${chunkFile} Sentry request owner must enter SDK isolation directly`
  );
  const scopeCallback = withScope[0].arguments[0];
  assert(
    nodeType(scopeCallback) === 'ArrowFunctionExpression',
    `${chunkFile} Sentry request owner must wrap the request inside isolation scope`
  );
  assert(
    nodeRangeSignature(scopeCallback.body) ===
      nodeRangeSignature(wrapRequest[0]),
    `${chunkFile} Sentry request owner must wrap the request inside isolation scope`
  );
  const requestHandler = wrapRequest[0].arguments[1];
  assert(
    nodeType(requestHandler) === 'ArrowFunctionExpression',
    `${chunkFile} Sentry request wrapper must own the application execution`
  );
  assertConditions(
    [
      requestHandler.async,
      namedCallsAnywhere(requestHandler, 'runApplicationOnce').length === 1,
    ],
    `${chunkFile} Sentry request wrapper must own the application execution`
  );
  assert(
    requestHandler.body.body.length > 0,
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  const requestExecution = requestHandler.body.body[0].expression;
  assert(
    nodeType(requestExecution) === 'AssignmentExpression',
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  assertConditions(
    [
      requestExecution.operator === '=',
      identifierName(requestExecution.left) === 'applicationOutcome',
      nodeType(requestExecution.right) === 'AwaitExpression',
    ],
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  const requestExecutionCall = requestExecution.right.argument;
  assert(
    nodeType(requestExecutionCall) === 'CallExpression',
    `${chunkFile} Sentry request wrapper must directly capture application execution`
  );
  assertConditions(
    [
      identifierName(requestExecutionCall.callee) === 'runApplicationOnce',
      requestExecutionCall.arguments.length === 0,
    ],
    `${chunkFile} Sentry request wrapper must directly capture application execution`
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
    runner.body.body.length === 2,
    `${chunkFile} Sentry request runner must own one memoized application execution`
  );
  const memoize = runner.body.body[0].expression;
  assertConditions(
    [
      nodeType(memoize) === 'AssignmentExpression',
      memoize.operator === '??=',
      identifierName(memoize.left) === 'applicationWork',
    ],
    `${chunkFile} Sentry request runner must memoize one application execution`
  );
  const thenCall = memoize.right;
  assertConditions(
    [
      nodeType(thenCall) === 'CallExpression',
      identifierName(thenCall.callee?.property) === 'then',
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
  assertConditions(
    [
      nodeType(executeApplication) === 'ArrowFunctionExpression',
      executeApplication.async,
      executeApplication.params.length === 0,
      executeApplication.body.body.length === 1,
      nodeType(executeApplication.body.body[0]) === 'TryStatement',
    ],
    `${chunkFile} Sentry request runner must isolate one async application execution`
  );
  const executionScope = executeApplication.body.body[0];
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
  assertConditions(
    [
      identifierName(response.argument?.callee) === 'handle',
      response.argument?.arguments.length === 0,
      literalString(outcome.get('type')) === 'responded',
    ],
    `${chunkFile} Sentry request runner must return the active application response`
  );
  const failureHandler = executionScope.handler;
  assertConditions(
    [
      nodeType(failureHandler) === 'CatchClause',
      identifierName(failureHandler?.param) === 'failure',
      failureHandler?.body.body.length === 1,
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
};

const assertCloudflareRuntimeOwnerImports = (
  program,
  fetchFunction,
  filePath
) => {
  assertExactEntryDynamicImport(
    program,
    filePath,
    ['createNoOpTelemetry', 'reportTelemetryFailure'],
    /^\.\/assets\/telemetry(?:-[\w-]+)?\.js$/
  );
  assertExactEntryDynamicImport(
    program,
    filePath,
    ['createCloudflareTelemetryAdapter'],
    /^\.\/assets\/telemetry-adapter(?:-[\w-]+)?\.js$/
  );
  assertExactEntryDynamicImport(
    program,
    filePath,
    ['tracing'],
    /^cloudflare:workers$/
  );
  const applicationDeclarator = assertCloudflareApplicationOwner(
    program,
    filePath
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
  assertCloudflareSentryRequestChunk(
    sentryImport.program,
    sentryImport.chunkFile
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
  assertCloudflareDatabaseChunk(
    databaseImport.program,
    databaseImport.chunkFile
  );
  const lifecycleOwner = 'scheduleCloudflareRequestFlush';
  const lifecycleImport = assertCloudflareNamedOwnerImport(program, filePath, {
    assetPattern: /^\.\/assets\/request-lifecycle(?:-[\w-]+)?\.js$/,
    exportedNames: [lifecycleOwner],
    requiredCalls: {
      [lifecycleOwner]: ['forceFlushRequestTelemetry', 'getTelemetry'],
    },
  });
  assertCloudflareLifecycleChunk(
    lifecycleImport.program,
    lifecycleImport.chunkFile
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
  const declarators = ownerNames.map((owner) => {
    const matches = topLevelBindingDeclarators(program, owner);
    assert(
      matches.length === 1,
      `${filePath} must import trusted owner ${owner} exactly once`
    );
    return matches[0];
  });
  const [declarator] = declarators;
  assert(
    declarators.every((candidate) => candidate === declarator),
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
    identifierName(applicationCall.arguments[0]) === 'request',
    `${filePath} active application handler must invoke application.fetch with the active request`
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
    identifierName(sentryCall.callee) === 'fetchCloudflareApplication',
    `${filePath} Worker fetch must return or await its Sentry-owned response`
  );
  const [sentryOptions = {}] = sentryCall.arguments;
  return ownerProperties(
    sentryOptions,
    filePath,
    'the active Cloudflare Sentry request owner'
  );
};

const assertCloudflareDatabaseOwner = (filePath) => {
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
  assertCloudflareRuntimeOwnerImports(program, fetchFunction, filePath);
  assertCloudflareApplicationHandler(fetchFunction, filePath);
  const options = cloudflareDatabaseOwnerProperties(fetchFunction, filePath);
  const sentryOptions = cloudflareOuterOwnerProperties(fetchFunction, filePath);
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

const staticImportsForBinding = (program, localName) =>
  program.body
    .map((statement) => staticImportForBinding(statement, localName))
    .filter(Boolean);

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
  assert(
    helperOwners.length === 1,
    `${helperChunk} must define trusted helper ${localName} exactly once`
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
};

const assertExactLocalChunkFunction = (program, chunkFile, localName) => {
  const localFunctions = program.body
    .flatMap(topLevelFunctionEntries)
    .filter(([name]) => name === localName);
  assert(
    localFunctions.length === 1,
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
  assertOnlyProfileMarker(serverEntry, 'cloudflare');
  assertCloudflareDatabaseOwner(serverEntry);
  assertRequiredRuntimeTokens(path.join(output, 'server'), 'cloudflare');
  assertNoForbiddenRuntimeTokens(path.join(output, 'server'), 'cloudflare');
};

export const verifyRuntimeProfile = (
  profile,
  root = process.cwd(),
  { expectedAppSlug = process.env.APP_SLUG, forbiddenBuildTokens = [] } = {}
) => {
  assert(profiles.has(profile), `unknown profile ${String(profile)}`);
  if (profile === 'node') verifyNode(root);
  else if (profile === 'vercel') verifyVercel(root);
  else verifyCloudflare(root, expectedAppSlug);
  assertNoArtifactTokens(
    runtimeArtifactOutput(profile, root),
    forbiddenBuildTokens
  );
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
