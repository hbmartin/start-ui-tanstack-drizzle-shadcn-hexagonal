import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright';
import { createPlugin, fromCrossJSON, toJSONAsync } from 'seroval';

import {
  createVerificationEnvironment,
  parseGeneratedCapabilityPreset,
  readGeneratedCapabilityPreset,
} from './runtime-verification-environment.mjs';
import { removeRuntimeArtifactOutput } from './runtime-artifact-output.mjs';
import {
  exitedVerificationChildError,
  formatRuntimeVerificationError,
  runtimeVerificationFailureExitCode,
  waitForSuccessfulChild,
} from './runtime-verification-child.mjs';
import { verifyRuntimeProfile } from './verify-runtime-profile.mjs';

export { createVerificationEnvironment, parseGeneratedCapabilityPreset };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const responseTimeoutMs = 8_000;
const startupTimeoutMs = 15_000;
const shutdownTimeoutMs = 5_000;
const cspNoncePlaceholder = '__START_UI_CSP_NONCE__';
const publicErrorCorrelationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const activeChildren = new Set();
let activeCleanup;
let activeDiagnostics = [];

const fail = (message) => {
  throw new Error(`Node runtime verification failed: ${message}`);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const publicServerErrorPlugin = createPlugin({
  tag: '$TSR/t/start-ui/server-error-v1',
  test: () => false,
  parse: {
    sync(value, context) {
      return { v: context.parse(value) };
    },
  },
  serialize: undefined,
  deserialize(node, context) {
    return context.deserialize(node.v);
  },
});

const hostilePublicServerErrorPlugin = createPlugin({
  tag: '$TSR/t/start-ui/server-error-v1',
  test: (value) =>
    typeof value === 'object' &&
    value !== null &&
    value.__hostilePublicServerError === true,
  parse: {
    async async(value, context) {
      return { v: await context.parse(value.payload) };
    },
  },
  serialize: undefined,
  deserialize(node, context) {
    return context.deserialize(node.v);
  },
});

export const parseServerFunctionId = (manifestSource, functionName) => {
  const escapedFunctionName = functionName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    '\\$&'
  );
  const match = manifestSource.match(
    new RegExp(
      `"([a-f0-9]{64})"\\s*:\\s*\\{\\s*functionName:\\s*"${escapedFunctionName}"`,
      'u'
    )
  );
  return match?.[1];
};

export const decodeServerFunctionResponse = (payload) =>
  fromCrossJSON(payload, { plugins: [publicServerErrorPlugin] });

export const createShutdownGuard = () => {
  let shutdownRequested = false;
  return Object.freeze({
    assertCanSpawn() {
      assert(!shutdownRequested, 'shutdown began before a child could start');
    },
    requestShutdown() {
      shutdownRequested = true;
    },
  });
};

const shutdownGuard = createShutdownGuard();

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseRequestedPort = (value, name) => {
  if (value === undefined) return 0;
  const port = Number(value);
  assert(
    Number.isSafeInteger(port) && port > 0 && port < 65_536,
    `${name} must be an integer from 1 to 65535`
  );
  return port;
};

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('TCP listener did not expose a numeric port'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

const canConnect = (port) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });

const childStartupFailure = (child, name) => {
  if (child.verificationSpawnError) {
    return new Error(
      `${name} could not start: ${child.verificationSpawnError.message}`,
      { cause: child.verificationSpawnError }
    );
  }
  return exitedVerificationChildError(child, `${name} exited before listening`);
};

const waitForPort = async (port, child, name) => {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const startupFailure = childStartupFailure(child, name);
    if (startupFailure) throw startupFailure;
    if (await canConnect(port)) return;
    await delay(100);
  }
  fail(`${name} did not listen on port ${port} within ${startupTimeoutMs}ms`);
};

const spawnManaged = (command, args, options) => {
  shutdownGuard.assertCanSpawn();
  const child = spawn(command, args, options);
  child.verificationSpawnError = undefined;
  child.verificationClosed = once(child, 'close').catch(() => undefined);
  activeChildren.add(child);
  child.once('error', (error) => {
    child.verificationSpawnError = error;
  });
  child.once('exit', () => activeChildren.delete(child));
  child.once('close', () => activeChildren.delete(child));
  return child;
};

const captureOutput = (child) => {
  let output = '';
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-20_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
};

const runCommand = (command, args, options = {}) => {
  const child = spawnManaged(command, args, {
    cwd: root,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
  });
  return waitForSuccessfulChild(child, command, args);
};

const hasChildExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;

const childIsUnavailableOrExited = (child) => !child || hasChildExited(child);

const waitForChildExit = (child, timeoutMs) => {
  if (hasChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('close', onExit);
      // oxlint-disable-next-line promise/no-multiple-resolved -- The settled guard arbitrates the exit/timeout race.
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
    if (hasChildExited(child)) finish(true);
  });
};

export const terminateChild = async (
  child,
  { gracefulTimeoutMs = shutdownTimeoutMs, killTimeoutMs = 1_000 } = {}
) => {
  if (childIsUnavailableOrExited(child)) return true;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, gracefulTimeoutMs)) return true;
  if (hasChildExited(child)) return true;
  child.kill('SIGKILL');
  return waitForChildExit(child, killTimeoutMs);
};

const tagAttributes = (tag) => {
  const attributeSource = tag
    .replace(/^<(?:script|style)\b/iu, '')
    .replace(/>$/u, '');
  return [
    ...attributeSource.matchAll(
      /[\t\n\f\r ]+([^\t\n\f\r />=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/gu
    ),
  ].map((match) => ({
    name: match[1].toLowerCase(),
    value: match[2] ?? match[3] ?? match[4],
  }));
};

const tagNonce = (tag) => {
  const nonceAttributes = tagAttributes(tag).filter(
    (attribute) => attribute.name === 'nonce'
  );
  return nonceAttributes.length === 1 ? nonceAttributes[0].value : undefined;
};

const directiveValue = (policy, directiveName) =>
  policy
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${directiveName} `));

const directiveNonce = (directive) => {
  if (!directive) return undefined;
  const nonces = [...directive.matchAll(/'nonce-([^']+)'/gu)].map(
    (match) => match[1]
  );
  return nonces.length === 1 ? nonces[0] : undefined;
};

const verifyCompletedHtmlResponse = ({ body, status }) => {
  assert(status === 200, `expected /login status 200, received ${status}`);
  assert(
    body.trimEnd().endsWith('</body></html>'),
    'the streamed HTML response did not terminate with </body></html>'
  );
  assert(
    body.includes('$_TSR.e()'),
    'the TanStack serialization stream did not emit its end marker'
  );
  assert(
    !body.includes(cspNoncePlaceholder),
    'the response contains an unresolved CSP nonce placeholder'
  );
};

const readResponseCspNonces = (headers) => {
  const csp = headers.get('content-security-policy') ?? '';
  const scriptDirective = directiveValue(csp, 'script-src');
  const styleDirective = directiveValue(csp, 'style-src');
  const scriptNonce = directiveNonce(scriptDirective);
  const styleNonce = directiveNonce(styleDirective);
  assert(scriptNonce, 'the CSP script-src directive has no unique nonce');
  assert(styleNonce, 'the CSP style-src directive has no unique nonce');
  assert(
    scriptNonce === styleNonce,
    'the CSP script-src and style-src nonces do not match'
  );
  return { scriptDirective, scriptNonce, styleDirective, styleNonce };
};

const verifySafeCspDirectives = ({ scriptDirective, styleDirective }) => {
  for (const [name, directive] of [
    ['script-src', scriptDirective],
    ['style-src', styleDirective],
  ]) {
    assert(
      !directive.includes("'unsafe-eval'") &&
        !directive.includes("'unsafe-inline'"),
      `the production CSP ${name} directive is unsafe`
    );
  }
};

const readExecutableTags = (body) => {
  const executableTags = [...body.matchAll(/<(?:script|style)\b[^>]*>/giu)].map(
    (match) => match[0]
  );
  assert(
    executableTags.length > 0,
    'the response contains no script/style tags'
  );
  return executableTags;
};

const expectedNonceForTag = (tag, scriptNonce, styleNonce) =>
  /^<script\b/iu.test(tag) ? scriptNonce : styleNonce;

const verifyExecutableTagNonces = ({
  executableTags,
  scriptNonce,
  styleNonce,
}) => {
  for (const tag of executableTags) {
    const nonceMatch = tagNonce(tag);
    assert(
      nonceMatch,
      `script/style tag is missing a nonce: ${tag.slice(0, 120)}`
    );
    const expectedNonce = expectedNonceForTag(tag, scriptNonce, styleNonce);
    assert(
      nonceMatch === expectedNonce,
      'a script/style nonce does not match its CSP directive nonce'
    );
  }
};

export const verifyNodeHtmlResponse = ({ body, headers, status }) => {
  verifyCompletedHtmlResponse({ body, status });
  const csp = readResponseCspNonces(headers);
  verifySafeCspDirectives(csp);
  const executableTags = readExecutableTags(body);
  verifyExecutableTagNonces({ executableTags, ...csp });

  return {
    bytes: Buffer.byteLength(body),
    cspNonce: csp.scriptNonce,
    executableTagCount: executableTags.length,
  };
};

const createRuntimeResources = () => {
  const applicationReservation = net.createServer();
  const databaseReservation = net.createServer();
  const redis = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: [1, -1] }));
  });
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...activeChildren].map((child) => terminateChild(child))
      );
      await Promise.all([
        closeServer(redis),
        closeServer(applicationReservation),
        closeServer(databaseReservation),
      ]);
      const failures = outcomes
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Node runtime verification child cleanup failed'
        );
      }
      assert(
        outcomes.every(
          (outcome) => outcome.status === 'fulfilled' && outcome.value
        ),
        'a Node runtime verification child survived SIGKILL'
      );
    })();
    return cleanupPromise;
  };
  return {
    applicationReservation,
    cleanup,
    databaseReservation,
    redis,
  };
};

const reserveRuntimePorts = ({
  applicationReservation,
  databaseReservation,
  redis,
}) =>
  Promise.all([
    listen(
      applicationReservation,
      parseRequestedPort(
        process.env.START_UI_NODE_VERIFY_PORT,
        'START_UI_NODE_VERIFY_PORT'
      )
    ),
    listen(
      databaseReservation,
      parseRequestedPort(
        process.env.START_UI_NODE_VERIFY_DATABASE_PORT,
        'START_UI_NODE_VERIFY_DATABASE_PORT'
      )
    ),
    listen(
      redis,
      parseRequestedPort(
        process.env.START_UI_NODE_VERIFY_REDIS_PORT,
        'START_UI_NODE_VERIFY_REDIS_PORT'
      )
    ),
  ]);

const buildNodeRuntimeArtifact = async (env) => {
  console.log('Building the Node runtime artifact...');
  removeRuntimeArtifactOutput('node', root);
  // Use the canonical build steps with an allowlisted environment. Calling
  // the dotenv-wrapped package script here could absorb real provider
  // credentials from a developer's .env into an ordinary verification run.
  await Promise.all([
    runCommand(
      process.execPath,
      ['./run-jiti', './scripts/validate-client-config.ts'],
      { env }
    ),
    runCommand(
      process.execPath,
      ['./run-jiti', './scripts/validate-server-build-config.ts'],
      { env }
    ),
    runCommand(
      process.execPath,
      [
        './run-jiti',
        './src/app/build-info/infrastructure/generate-build-info.ts',
      ],
      { env }
    ),
  ]);
  await runCommand(path.join(root, 'node_modules/.bin/vite'), ['build'], {
    env,
  });
  verifyRuntimeProfile('node', root, {
    forbiddenBuildTokens: [env.VITE_BASE_URL],
  });
};

const registerDiagnosticOutput = (diagnostics, name, child) =>
  diagnostics.push({ child, name, readOutput: captureOutput(child) });

const verifyPgliteIdentity = async (databaseUrl) => {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
  });
  await client.connect();
  try {
    const result = await client.query('select version() as version');
    assert(
      typeof result.rows[0]?.version === 'string' &&
        result.rows[0].version.includes('PGlite'),
      'the reserved database port was not claimed by PGlite'
    );
  } finally {
    await client.end();
  }
};

const assertChildRunning = (child, name) => {
  if (child.verificationSpawnError) {
    fail(`${name} failed to start: ${child.verificationSpawnError.message}`);
  }
  const exitError = exitedVerificationChildError(
    child,
    `${name} exited before the runtime contract completed`
  );
  if (exitError) throw exitError;
};

const startPglite = async ({
  databasePort,
  databaseReservation,
  diagnostics,
  env,
}) => {
  console.log('Starting an isolated PGlite database...');
  await closeServer(databaseReservation);
  const pglite = spawnManaged(
    path.join(root, 'node_modules/.bin/pglite-server'),
    ['--db=memory://', `--port=${databasePort}`, '--max-connections=16'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  registerDiagnosticOutput(diagnostics, 'PGlite', pglite);
  await waitForPort(databasePort, pglite, 'PGlite');
  await verifyPgliteIdentity(env.DATABASE_URL);
  await runCommand(
    process.execPath,
    ['./run-jiti', './src/modules/kernel/infrastructure/db/migrate-cli.ts'],
    { env }
  );
  assertChildRunning(pglite, 'PGlite');
  return pglite;
};

const startNodeApplication = async ({
  appPort,
  applicationReservation,
  diagnostics,
  env,
}) => {
  console.log('Starting the built Node server...');
  await closeServer(applicationReservation);
  const application = spawnManaged(
    process.execPath,
    [path.join(root, '.output/node/server/index.mjs')],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  registerDiagnosticOutput(diagnostics, 'Node', application);
  await waitForPort(appPort, application, 'Node application');
  assertChildRunning(application, 'Node application');
  return application;
};

const fatalProbeImportUrl = (mode, secret) => {
  const source = `
    const ready = Symbol.for('start-ui-web.telemetry.fatal-owner-ready');
    const trigger = () => {
      if (!globalThis[ready]) process.exit(9);
      const failure = new Error(${JSON.stringify(secret)});
      if (${JSON.stringify(mode)} === 'reject') {
        void Promise.reject(failure);
      } else {
        throw failure;
      }
    };
    process.once('SIGUSR2', trigger);
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
};

const createFatalCollector = () => {
  const envelopes = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    envelopes.push(Buffer.concat(chunks).toString('utf8'));
    response.end('ok');
  });
  return { envelopes, server };
};

const captureFatalChildOutput = (child) => {
  const output = { stderr: '', stdout: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });
  return output;
};

const assertBuiltNodeFatalResult = ({
  child,
  envelopes,
  mode,
  output,
  secret,
}) => {
  assert(
    child.exitCode === 1,
    `built Node ${mode} fatal probe exited ${child.exitCode}; stdout: ${output.stdout}; stderr: ${output.stderr}`
  );
  assert(
    output.stderr.includes('runtime.fatal'),
    `built Node ${mode} fatal probe omitted the safe diagnostic`
  );
  assert(
    output.stderr.match(/runtime\.fatal/gu)?.length === 1,
    `built Node ${mode} fatal probe emitted multiple fatal diagnostics: ${output.stderr}`
  );
  assert(
    !output.stderr.includes(secret),
    `built Node ${mode} fatal probe leaked its raw failure: ${output.stderr}`
  );
  assert(
    !output.stderr.includes('[uncaughtException]'),
    `built Node ${mode} fatal probe leaked Nitro uncaught output: ${output.stderr}`
  );
  assert(
    !output.stderr.includes('[unhandledRejection]'),
    `built Node ${mode} fatal probe leaked Nitro rejection output: ${output.stderr}`
  );
  assert(
    envelopes.length === 1,
    `built Node ${mode} fatal probe exported ${envelopes.length} envelopes`
  );
  const envelope = envelopes[0];
  assert(
    !envelope.includes(secret),
    `built Node ${mode} fatal envelope leaked its raw failure`
  );
  assert(
    envelope.includes('Unexpected application error'),
    `built Node ${mode} fatal envelope was not sanitized`
  );
};

const verifyBuiltNodeFatalMode = async ({ env, mode }) => {
  const { envelopes, server: collector } = createFatalCollector();
  const collectorPort = await listen(collector, 0);
  const secret = `built-${mode}-fatal-secret`;
  const child = spawnManaged(
    process.execPath,
    [
      '--import',
      fatalProbeImportUrl(mode, secret),
      path.join(root, '.output/node/server/index.mjs'),
    ],
    {
      cwd: root,
      env: {
        ...env,
        SENTRY_DSN: `http://public@127.0.0.1:${collectorPort}/1`,
        SENTRY_ENVIRONMENT: 'tests',
        SENTRY_RELEASE: `start-ui-web@5.0.0-${mode}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const output = captureFatalChildOutput(child);

  try {
    const appPort = Number(env.PORT);
    await waitForPort(appPort, child, `built Node ${mode} fatal probe`);
    await fetchVerifiedLogin(appPort, `fatal-${mode}`);
    assertChildRunning(child, `built Node ${mode} warmed fatal probe`);
    assert(child.kill('SIGUSR2'), `built Node ${mode} fatal signal failed`);
    const exited = await waitForChildExit(child, 10_000);
    if (!exited) {
      await terminateChild(child, {
        gracefulTimeoutMs: 100,
        killTimeoutMs: 1_000,
      });
      fail(`built Node ${mode} fatal probe did not exit`);
    }
    assertBuiltNodeFatalResult({ child, envelopes, mode, output, secret });
  } finally {
    await closeServer(collector);
  }
};

const verifyBuiltNodeFatalLifecycle = async (env) => {
  for (const mode of ['throw', 'reject']) {
    await verifyBuiltNodeFatalMode({ env, mode });
  }
  console.log(
    'Verified built Node fatal ownership: sanitized stderr, one envelope, bounded exit.'
  );
};

const fetchVerifiedLogin = async (appPort, requestNumber) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), responseTimeoutMs);
  try {
    const response = await fetch(`http://localhost:${appPort}/login`, {
      signal: controller.signal,
    });
    const body = await response.text();
    return verifyNodeHtmlResponse({
      body,
      headers: response.headers,
      status: response.status,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      fail(
        `/login request ${requestNumber} did not complete within ${responseTimeoutMs}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const readBuiltServerFunctionId = async (functionName) => {
  const serverOutput = path.join(root, '.output/node/server');
  const resolverFile = (await readdir(serverOutput)).find((file) =>
    file.startsWith('__23tanstack-start-server-fn-resolver-')
  );
  assert(resolverFile, 'the Node server-function resolver was not built');
  const source = await readFile(path.join(serverOutput, resolverFile), 'utf8');
  const functionId = parseServerFunctionId(source, functionName);
  assert(functionId, `the Node build omitted ${functionName}`);
  return functionId;
};

const requestBuiltServerFunction = async ({
  appPort,
  data,
  functionId,
  plugins,
}) => {
  const serializedPayload = JSON.stringify(
    await Promise.resolve(
      toJSONAsync({ data }, plugins ? { plugins } : undefined)
    )
  );
  const url = new URL(`http://localhost:${appPort}/_serverFn/${functionId}`);
  url.searchParams.set('payload', serializedPayload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), responseTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: `http://localhost:${appPort}/login`,
        'Sec-Fetch-Site': 'same-origin',
        'x-tsr-serverFn': 'true',
      },
      signal: controller.signal,
    });
    const rawBody = await response.text();
    return { headers: response.headers, rawBody, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
};

const assertClosedBadRequest = ({ headers, label, rawBody, status }) => {
  assert(status === 400, `${label} was HTTP ${status}, expected HTTP 400`);
  assert(
    headers.get('x-tss-serialized') === 'true',
    `${label} bypassed TanStack serialization`
  );
  const decoded = decodeServerFunctionResponse(JSON.parse(rawBody));
  const error = decoded?.error;
  assert(
    error && typeof error === 'object',
    `${label} omitted its public error`
  );
  assert(
    JSON.stringify(Object.keys(error).toSorted()) ===
      JSON.stringify(['correlationId', 'reason', 'target', 'version']),
    `${label} changed the four-field DTO`
  );
  assert(error.version === 1, `${label} changed the DTO version`);
  assert(
    error.target === 'request' && error.reason === 'invalid_input',
    `${label} changed validation classification`
  );
  assert(
    publicErrorCorrelationIdPattern.test(error.correlationId),
    `${label} did not contain an opaque correlation ID`
  );
  assert(
    headers.get('x-request-id') === error.correlationId,
    `${label} did not use the entrypoint request ID for public correlation`
  );
  return error;
};

const verifyBuiltNodeServerFunctionErrorContract = async (appPort) => {
  const functionId = await readBuiltServerFunctionId(
    'bookGetById_createServerFn_handler'
  );
  const invalidInput = await requestBuiltServerFunction({
    appPort,
    data: {
      id: '   ',
      hostile: 'hostile-wire-secret',
      provider: { apiKey: 'provider-wire-secret' },
    },
    functionId,
  });
  assertClosedBadRequest({
    ...invalidInput,
    label: 'invalid server-function input',
  });
  assert(
    !/hostile-wire-secret|provider-wire-secret|apiKey|"message"|"stack"|"cause"/iu.test(
      invalidInput.rawBody
    ),
    'the built server-function response exposed an open-ended error field'
  );

  const malformedAdapter = await requestBuiltServerFunction({
    appPort,
    data: {
      id: {
        __hostilePublicServerError: true,
        payload: {
          correlationId: 'attacker-controlled-correlation',
          provider: { apiKey: 'malformed-provider-secret' },
          reason: 'not_closed',
          target: 'arbitrary.field',
          version: 1,
        },
      },
    },
    functionId,
    plugins: [hostilePublicServerErrorPlugin],
  });
  assertClosedBadRequest({
    ...malformedAdapter,
    label: 'malformed server-error adapter input',
  });
  assert(
    !/attacker-controlled|malformed-provider-secret|apiKey|arbitrary\.field|not_closed|"message"|"stack"|"cause"/iu.test(
      malformedAdapter.rawBody
    ),
    'malformed adapter input leaked into the server-function response'
  );

  console.log(
    'Verified built Node server-function validation and malformed adapter handling: HTTP 400, entrypoint correlation, and exact closed DTO.'
  );
};

const verifyNodeLoginResponses = async ({
  appPort,
  application,
  pglite,
  preset,
}) => {
  const startedAt = Date.now();
  const summaries = [];
  for (let requestNumber = 1; requestNumber <= 2; requestNumber += 1) {
    summaries.push(await fetchVerifiedLogin(appPort, requestNumber));
    assertChildRunning(application, 'Node application');
    assertChildRunning(pglite, 'PGlite');
  }
  assert(
    summaries[0].cspNonce !== summaries[1].cspNonce,
    'consecutive responses reused the same CSP nonce'
  );
  console.log(
    `Verified Node ${preset} /login twice: HTTP 200, ${
      summaries[0].bytes
    } bytes, ${Date.now() - startedAt}ms, ${
      summaries[0].executableTagCount
    } nonce-bearing script/style tags.`
  );
};

const parseGithubOAuthRedirectPayload = (body) => {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    fail('one-hop trusted production auth returned malformed JSON');
  }
  assert(
    typeof payload === 'object',
    'one-hop trusted production auth returned a non-object payload'
  );
  assert(
    payload !== null,
    'one-hop trusted production auth returned a null payload'
  );
  assert(
    payload.redirect === true,
    'one-hop trusted production auth did not request an OAuth redirect'
  );
  assert(
    typeof payload.url === 'string',
    'one-hop trusted production auth omitted its OAuth URL'
  );
  return payload;
};

const verifyGithubOAuthRedirectPayload = (body, canonicalOrigin) => {
  const payload = parseGithubOAuthRedirectPayload(body);
  const authorizationUrl = new URL(payload.url);
  assert(
    authorizationUrl.hostname === 'github.com',
    'one-hop trusted production auth did not reach GitHub'
  );
  assert(
    authorizationUrl.pathname === '/login/oauth/authorize',
    'one-hop trusted production auth returned an unexpected GitHub path'
  );
  assert(
    authorizationUrl.searchParams.get('redirect_uri') ===
      `${canonicalOrigin}/api/auth/callback/github`,
    'one-hop trusted production auth did not use the canonical callback origin'
  );
};

const verifyNodeTrustedAuthClientIp = async (appPort, canonicalOrigin) => {
  const url = `http://localhost:${appPort}/api/auth/sign-in/social`;
  const body = JSON.stringify({ provider: 'github' });
  const mutationHeaders = {
    'Content-Type': 'application/json',
    Origin: canonicalOrigin,
    'Sec-Fetch-Site': 'same-origin',
  };
  const unavailable = await fetch(url, {
    body,
    headers: mutationHeaders,
    method: 'POST',
    signal: AbortSignal.timeout(responseTimeoutMs),
  });
  assert(
    unavailable.status === 503,
    `headerless production auth was HTTP ${unavailable.status}, expected HTTP 503`
  );
  assert(
    unavailable.headers.get('retry-after') === '60',
    'headerless production auth omitted its bounded Retry-After'
  );

  const trusted = await fetch(url, {
    body,
    headers: {
      ...mutationHeaders,
      'X-Forwarded-For': '203.0.113.10',
    },
    method: 'POST',
    signal: AbortSignal.timeout(responseTimeoutMs),
  });
  const trustedBody = await trusted.text();
  assert(
    trusted.status === 200,
    `one-hop trusted production auth was HTTP ${trusted.status}, expected HTTP 200: ${trustedBody.slice(0, 240)}`
  );
  verifyGithubOAuthRedirectPayload(trustedBody, canonicalOrigin);
  console.log(
    'Verified Node trusted client-IP ingress: headerless HTTP 503 and one-hop GitHub OAuth HTTP 200.'
  );
};

const isCspConsoleViolation = (message) =>
  /content security policy|refused to (?:apply|execute|load)/iu.test(message);

const verifyBrowserElementNonces = async (page, expectedNonce) => {
  const nonces = await page
    .locator('script, style')
    .evaluateAll((elements) => elements.map((element) => element.nonce));
  assert(nonces.length > 0, 'the hydrated document has no script/style tags');
  assert(
    nonces.every((nonce) => nonce === expectedNonce),
    'a hydrated script/style tag has a missing or incorrect CSP nonce'
  );
};

const verifyStrictCspBrowserHydration = async (appPort) => {
  const browser = await chromium.launch({ headless: true });
  const browserFailures = [];
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || isCspConsoleViolation(message.text())) {
        browserFailures.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserFailures.push(error.message));
    page.on('requestfailed', (request) => {
      browserFailures.push(
        `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? 'request failed'}`
      );
    });

    const response = await page.goto(`http://localhost:${appPort}/login`, {
      timeout: responseTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    assert(response?.status() === 200, 'the browser did not receive HTTP 200');
    const policy = response.headers()['content-security-policy'] ?? '';
    const csp = readResponseCspNonces(
      new Headers({ 'content-security-policy': policy })
    );
    try {
      await page
        .locator('[data-testid="auth-login-form"][data-hydrated="true"]')
        .waitFor({ timeout: responseTimeoutMs });
    } catch {
      const details = browserFailures.slice(0, 5).join(' | ');
      fail(`strict-CSP login did not hydrate${details ? `: ${details}` : ''}`);
    }
    await page.locator('input[type="email"]').fill('csp@example.test');

    // React hoists styles that declare href + precedence and exposes the
    // resource identity through data-href in the hydrated document.
    const baseUiStyle = page.locator(
      'style[data-href~="base-ui-disable-scrollbar"]'
    );
    assert(
      (await baseUiStyle.count()) === 0,
      'the Base UI scrollbar style existed before the Select was opened'
    );

    // The application bridge pre-nonces dynamically created style elements.
    // Remove only that createElement-time contribution in this test page so
    // the assertion below proves Base UI received the nonce through its React
    // CSPProvider. React applies the nonce prop after createElement returns.
    await page.evaluate(() => {
      const prototype = Document.prototype;
      const createElement = prototype.createElement;
      prototype.createElement = function (tagName, options) {
        const element = createElement.call(this, tagName, options);
        if (typeof tagName === 'string' && tagName.toLowerCase() === 'style') {
          element.removeAttribute('nonce');
        }
        return element;
      };
    });

    await page.getByRole('combobox', { name: 'Language' }).click();
    await page.getByRole('option').first().waitFor({
      timeout: responseTimeoutMs,
    });
    await baseUiStyle.waitFor({
      state: 'attached',
      timeout: responseTimeoutMs,
    });
    assert(
      (await baseUiStyle.evaluate((element) => element.nonce)) ===
        csp.scriptNonce,
      'the Base UI scrollbar style did not receive the request CSP nonce'
    );
    await verifyBrowserElementNonces(page, csp.scriptNonce);
    assert(
      browserFailures.length === 0,
      `strict-CSP browser hydration failed: ${browserFailures.join(' | ')}`
    );
    console.log(
      'Verified strict-CSP Chromium hydration and Base UI Select nonce use.'
    );
  } finally {
    await browser.close();
  }
};

const renderDiagnostic = async ({ child, name, readOutput }) => {
  await Promise.race([child.verificationClosed, delay(250)]);
  const output = readOutput();
  return output ? `${name} output:\n${output}` : '';
};

const writeStderr = (message) =>
  new Promise((resolve) => {
    process.stderr.write(`${message}\n`, resolve);
  });

const printDiagnostics = async (diagnostics) => {
  const logs = (await Promise.all(diagnostics.map(renderDiagnostic)))
    .filter(Boolean)
    .join('\n');
  if (logs) await writeStderr(logs);
};

export const cleanupNodeVerificationOnSignal = async ({
  children,
  cleanup,
  diagnostics,
  print = printDiagnostics,
  terminate = terminateChild,
}) => {
  let cleanupError;
  try {
    if (cleanup) {
      await cleanup();
    } else {
      const outcomes = await Promise.all(
        [...children].map((child) => terminate(child))
      );
      assert(
        outcomes.every(Boolean),
        'a Node runtime verification child survived SIGKILL'
      );
    }
  } catch (error) {
    cleanupError = error;
  }

  let diagnosticError;
  try {
    await print(diagnostics);
  } catch (error) {
    diagnosticError = error;
  }

  if (cleanupError && diagnosticError) {
    throw new AggregateError(
      [cleanupError, diagnosticError],
      'Node runtime signal cleanup failed and diagnostics were incomplete'
    );
  }
  if (cleanupError) throw cleanupError;
  if (diagnosticError) throw diagnosticError;
};

export const verifyNodeRuntime = async () => {
  const resources = createRuntimeResources();
  const diagnostics = [];
  let verificationError;
  activeCleanup = resources.cleanup;
  activeDiagnostics = diagnostics;

  try {
    const [appPort, databasePort, redisPort] =
      await reserveRuntimePorts(resources);
    const preset = readGeneratedCapabilityPreset(root);
    const env = createVerificationEnvironment({
      appPort,
      databasePort,
      preset,
      redisPort,
    });

    await buildNodeRuntimeArtifact(env);
    const pglite = await startPglite({
      databasePort,
      databaseReservation: resources.databaseReservation,
      diagnostics,
      env,
    });
    const application = await startNodeApplication({
      appPort,
      applicationReservation: resources.applicationReservation,
      diagnostics,
      env,
    });
    await verifyNodeLoginResponses({ appPort, application, pglite, preset });
    await verifyNodeTrustedAuthClientIp(appPort, env.APP_DOMAIN);
    await verifyBuiltNodeServerFunctionErrorContract(appPort);
    await verifyStrictCspBrowserHydration(appPort);
    assertChildRunning(application, 'Node application');
    assertChildRunning(pglite, 'PGlite');
    assert(
      await terminateChild(application),
      'the Node application survived SIGKILL after verification'
    );
    await verifyBuiltNodeFatalLifecycle(env);
    assertChildRunning(pglite, 'PGlite');
  } catch (error) {
    verificationError = error;
    try {
      await printDiagnostics(diagnostics);
    } catch (diagnosticError) {
      const combined = new AggregateError(
        [verificationError, diagnosticError],
        'Node runtime verification failed and diagnostics were incomplete'
      );
      combined.exitCode = verificationError?.exitCode;
      combined.signal = verificationError?.signal;
      combined.status = verificationError?.status;
      verificationError = combined;
    }
  }
  let cleanupError;
  try {
    await resources.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (activeCleanup === resources.cleanup) activeCleanup = undefined;
  if (activeDiagnostics === diagnostics) activeDiagnostics = [];
  if (verificationError && cleanupError) {
    const combined = new AggregateError(
      [verificationError, cleanupError],
      'Node runtime verification failed and child cleanup was incomplete'
    );
    combined.exitCode = verificationError?.exitCode;
    combined.signal = verificationError?.signal;
    combined.status = verificationError?.status;
    throw combined;
  }
  if (cleanupError) throw cleanupError;
  if (verificationError) throw verificationError;
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let signalShutdownStarted = false;
  const handleSignal = async (signal) => {
    if (signalShutdownStarted) return;
    signalShutdownStarted = true;
    shutdownGuard.requestShutdown();
    try {
      await cleanupNodeVerificationOnSignal({
        children: activeChildren,
        cleanup: activeCleanup,
        diagnostics: activeDiagnostics,
      });
    } catch (error) {
      try {
        await writeStderr(formatRuntimeVerificationError(error));
      } catch {
        // The original signal remains authoritative if stderr itself failed.
      }
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => void handleSignal('SIGINT'));
  process.once('SIGTERM', () => void handleSignal('SIGTERM'));
  verifyNodeRuntime().catch((error) => {
    console.error(formatRuntimeVerificationError(error));
    process.exitCode = runtimeVerificationFailureExitCode(error);
  });
}
