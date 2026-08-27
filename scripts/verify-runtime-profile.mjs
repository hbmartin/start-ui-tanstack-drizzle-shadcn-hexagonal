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

const directDeclaredNames = (functionNode) => {
  const names = new Set();
  const nestedRanges = nestedFunctionRanges(functionNode);
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

const assertNoCloudflareOwnerOverrides = (fetchFunction, filePath) => {
  const declared = directDeclaredNames(fetchFunction);
  const mutated = mutatedNames(fetchFunction);
  const trustedOwners = [
    'application',
    'fetchCloudflareApplication',
    'runWithCloudflareDatabase',
  ];
  for (const owner of trustedOwners) {
    assert(
      !declared.has(owner) && !mutated.has(owner),
      `${filePath} Worker fetch must not override trusted owner ${owner}`
    );
  }
  const activeBindings = [
    'context',
    'environment',
    'handleApplication',
    'handleDatabase',
    'request',
    'sentryOptions',
  ];
  for (const binding of activeBindings) {
    assert(
      !mutated.has(binding),
      `${filePath} Worker fetch must not mutate active binding ${binding}`
    );
  }
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
    ['application', 1],
    ['fetchCloudflareApplication', 1],
    ['runWithCloudflareDatabase', 1],
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
  assert(
    finalStatement.block.body.length === 1,
    `${filePath} Worker Sentry ownership scope must contain one return`
  );
  const [ownerReturn = {}] = finalStatement.block.body;
  assert(
    ownerReturn.type === 'ReturnStatement',
    `${filePath} Worker Sentry ownership scope must return its response`
  );
  const sentryCall = unwrapAwaitExpression(ownerReturn.argument);
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
  assertNoCloudflareOwnerOverrides(fetchFunction, filePath);
  assertExactCloudflareOwnerUsage(fetchFunction, filePath);
  assertNoProgramCloudflareOwnerAliases(program, fetchFunction, filePath);
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
