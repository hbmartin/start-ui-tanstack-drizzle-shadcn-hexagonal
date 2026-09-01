import {
  randomBytes as defaultRandomBytes,
  randomUUID as defaultRandomUuid,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  applyEdits,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';

const presets = new Set(['core', 'demo']);
const capabilityPresetDefinitionsPath = new URL(
  '../src/modules/kernel/domain/capability-presets.json',
  import.meta.url
);
const capabilityIdsByPreset = JSON.parse(
  fs.readFileSync(capabilityPresetDefinitionsPath, 'utf8')
);
const slugPattern = /^(?=.{2,63}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const controlCharacterPattern = /\p{Cc}/u;
const placeholderPattern = /(?:replace[ _-]?me|changeme|<[^@>]+>)/iu;
const disabledOptionalKeys = [
  'EMAIL_SERVER',
  'HONEYCOMB_API_KEY',
  'HONEYCOMB_DATASET',
  'HONEYCOMB_OTLP_ENDPOINT',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'SENTRY_OTLP_AUTH_HEADER',
  'SENTRY_OTLP_ENDPOINT',
];

const usage = `Usage: pnpm setup -- --preset=core|demo --app-name="My App" --app-slug=my-app [--yes] [--dry-run]

There is no default preset. Interactive runs prompt for missing values.
Non-interactive --yes runs require --preset, --app-name, and --app-slug.`;

const setupArgumentOptions = {
  'app-name': { type: 'string' },
  'app-slug': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { short: 'h', type: 'boolean' },
  preset: { type: 'string' },
  yes: { type: 'boolean' },
};

const setupArgumentErrorMessage = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return `Unknown setup option: ${message}`;
  }
  return `Invalid setup arguments: ${message}`;
};

const parseKnownSetupArguments = (argv) => {
  try {
    return parseArgs({
      allowPositionals: false,
      args: argv,
      options: setupArgumentOptions,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    throw new Error(setupArgumentErrorMessage(error));
  }
};

const assertNoDuplicateValueOptions = (tokens) => {
  const valueOptionNames = new Set(['app-name', 'app-slug', 'preset']);
  const names = tokens
    .filter(
      (token) => token.kind === 'option' && valueOptionNames.has(token.name)
    )
    .map((token) => token.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`Duplicate setup option: --${duplicate}`);
};

export const parseSetupArguments = (argv) => {
  const { tokens, values } = parseKnownSetupArguments(argv);
  assertNoDuplicateValueOptions(tokens);
  return {
    appName: values['app-name'],
    appSlug: values['app-slug'],
    dryRun: values['dry-run'] ?? false,
    help: values.help ?? false,
    preset: values.preset,
    yes: values.yes ?? false,
  };
};

const validateName = (value) => {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 100 ||
    controlCharacterPattern.test(normalized)
  ) {
    throw new Error(
      'APP_NAME must contain between 1 and 100 characters without control characters.'
    );
  }
  return normalized;
};

const validateSlug = (value) => {
  const normalized = value?.trim() ?? '';
  if (!slugPattern.test(normalized)) {
    throw new Error(
      'APP_SLUG must be 2-63 lowercase letters, numbers, or single hyphen-separated segments.'
    );
  }
  return normalized;
};

const validatePreset = (value) => {
  const normalized = value?.trim();
  if (!presets.has(normalized)) {
    throw new Error(
      'CAPABILITY_PRESET must be explicitly set to core or demo.'
    );
  }
  return normalized;
};

const missingSetupInputs = (options) =>
  ['preset', 'appName', 'appSlug'].filter((key) => !options[key]);

const assertSetupInputsAvailable = (options, prompt) => {
  if (missingSetupInputs(options).length === 0) return;
  if (options.yes) {
    throw new Error(
      '--yes requires --preset, --app-name, and --app-slug so setup remains deterministic.'
    );
  }
  if (!prompt) {
    throw new Error(
      'Setup needs an interactive terminal or explicit --preset, --app-name, and --app-slug values.'
    );
  }
};

const resolveSetupValue = async (value, prompt, question, validate) =>
  validate(value ?? (await prompt(question)));

const confirmSetup = async (options, prompt, { appName, appSlug, preset }) => {
  if (options.yes) return;
  if (options.dryRun) return;
  const answer = (
    await prompt(`Write ${preset} setup for ${appName} (${appSlug})? [y/N] `)
  )
    .trim()
    .toLowerCase();
  if (!['y', 'yes'].includes(answer)) {
    throw new Error('Setup cancelled without changing files.');
  }
};

export const resolveSetupOptions = async (options, prompt) => {
  if (options.help) return options;
  assertSetupInputsAvailable(options, prompt);

  const preset = await resolveSetupValue(
    options.preset,
    prompt,
    'Preset (core or demo): ',
    validatePreset
  );
  const appName = await resolveSetupValue(
    options.appName,
    prompt,
    'Application name: ',
    validateName
  );
  const appSlug = await resolveSetupValue(
    options.appSlug,
    prompt,
    'Stable application slug: ',
    validateSlug
  );
  await confirmSetup(options, prompt, { appName, appSlug, preset });

  return { ...options, appName, appSlug, preset };
};

const parseDoubleQuotedEnvValue = (value) => {
  try {
    const quoted = value.match(/^"(?:\\.|[^"\\])*"/u)?.[0];
    return JSON.parse(quoted ?? value);
  } catch {
    return value;
  }
};

const parseSingleQuotedEnvValue = (value) => {
  const end = value.indexOf("'", 1);
  return end === -1 ? value : value.slice(1, end);
};

const parseEnvValue = (raw) => {
  const value = raw.trim();
  if (value.startsWith('"')) return parseDoubleQuotedEnvValue(value);
  if (value.startsWith("'")) return parseSingleQuotedEnvValue(value);
  return value.replace(/\s+#.*$/u, '').trim();
};

const addEnvAssignment = (values, line) => {
  const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u.exec(line);
  if (!match) return;
  const [, key, rawValue] = match;
  if (values.has(key)) {
    throw new Error(`Duplicate active environment key: ${key}`);
  }
  values.set(key, parseEnvValue(rawValue));
};

export const readEnvAssignments = (source) => {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) addEnvAssignment(values, line);
  return values;
};

const setEnvValue = (source, key, value) => {
  const replacement = `${key}=${JSON.stringify(value)}`;
  const lines = source.split(/\r?\n/u);
  const index = lines.findIndex((line) =>
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'u').test(line)
  );
  if (index === -1) {
    const insertion = lines.at(-1) === '' ? lines.length - 1 : lines.length;
    lines.splice(insertion, 0, replacement);
  } else {
    lines[index] = replacement;
  }
  return lines.join('\n');
};

const generatedSecret = (randomBytes, purpose, bytes = 48) =>
  `${purpose.toLowerCase()}_${randomBytes(bytes).toString('base64url')}`;

const isStrongSecret = (value) =>
  typeof value === 'string' &&
  value.length >= 32 &&
  !placeholderPattern.test(value);

const resolveSecret = (assignments, key, randomBytes, disallowed) => {
  const existing = assignments.get(key);
  return isStrongSecret(existing) && existing !== disallowed
    ? existing
    : generatedSecret(randomBytes, key);
};

const isConfiguredValue = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !placeholderPattern.test(value);

const resolveCredential = (
  assignments,
  key,
  randomBytes,
  preserveConfiguredAdapters
) => {
  const existing = assignments.get(key);
  return preserveConfiguredAdapters && isConfiguredValue(existing)
    ? existing
    : generatedSecret(randomBytes, key);
};

const assertNoActivePlaceholders = (source) => {
  const unresolved = [...readEnvAssignments(source)]
    .filter(([, value]) => placeholderPattern.test(value))
    .map(([key]) => key);
  if (unresolved.length > 0) {
    throw new Error(
      `Setup left unresolved active placeholders: ${unresolved.join(', ')}`
    );
  }
};

const createBaseSetupValues = ({
  appName,
  appSlug,
  current,
  preset,
  preserveConfiguredAdapters,
  randomBytes,
}) => {
  const authSecret = resolveSecret(current, 'AUTH_SECRET', randomBytes);
  const rateLimitSecret = resolveSecret(
    current,
    'AUTH_RATE_LIMIT_HMAC_SECRET',
    randomBytes,
    authSecret
  );
  return new Map([
    ['SETUP_VERSION', '1'],
    ['APP_NAME', appName],
    ['APP_SLUG', appSlug],
    ['CAPABILITY_PRESET', preset],
    ['AUTH_SECRET', authSecret],
    ['AUTH_RATE_LIMIT_HMAC_SECRET', rateLimitSecret],
    ['EMAIL_DELIVERY_DISABLED', 'true'],
    ['OTEL_SERVICE_NAME', appSlug],
    ['VITE_OTEL_SERVICE_NAME', appSlug],
    [
      'DOCKER_DATABASE_PASSWORD',
      resolveCredential(
        current,
        'DOCKER_DATABASE_PASSWORD',
        randomBytes,
        preserveConfiguredAdapters
      ),
    ],
  ]);
};

const configuredValueOr = (
  current,
  key,
  preserveConfiguredAdapters,
  fallback
) => {
  const existing = current.get(key);
  if (preserveConfiguredAdapters && isConfiguredValue(existing)) {
    return existing;
  }
  return fallback;
};

const emailDeliveryDisabledValue = (current, values) => {
  const hasConfiguredEmailAdapter = ['EMAIL_SERVER', 'RESEND_API_KEY'].some(
    (key) => values.get(key)
  );
  if (!hasConfiguredEmailAdapter) return 'true';
  return current.get('EMAIL_DELIVERY_DISABLED') ?? 'false';
};

const applyOptionalAdapterValues = ({
  appName,
  current,
  preserveConfiguredAdapters,
  values,
}) => {
  for (const key of disabledOptionalKeys) {
    values.set(
      key,
      configuredValueOr(current, key, preserveConfiguredAdapters, '')
    );
  }
  values.set(
    'EMAIL_FROM',
    configuredValueOr(
      current,
      'EMAIL_FROM',
      preserveConfiguredAdapters,
      `${appName} <noreply@localhost>`
    )
  );
  values.set(
    'EMAIL_DELIVERY_DISABLED',
    emailDeliveryDisabledValue(current, values)
  );
};

const applyCoreStorageValues = ({ values }) => {
  for (const key of [
    'DOCKER_MINIO_API_PORT',
    'DOCKER_MINIO_PASSWORD',
    'DOCKER_MINIO_UI_PORT',
    'DOCKER_MINIO_USERNAME',
    'S3_ACCESS_KEY_ID',
    'S3_BUCKET_NAME',
    'S3_FORCE_PATH_STYLE',
    'S3_HOST',
    'S3_SECURE',
    'S3_SECRET_ACCESS_KEY',
    'VITE_S3_BUCKET_PUBLIC_URL',
  ]) {
    values.set(key, '');
  }
};

const applyDemoStorageValues = ({
  current,
  preserveConfiguredAdapters,
  randomBytes,
  values,
}) => {
  for (const key of [
    'DOCKER_MINIO_PASSWORD',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ]) {
    values.set(
      key,
      resolveCredential(current, key, randomBytes, preserveConfiguredAdapters)
    );
  }
};

const applyStorageValues = (options) => {
  if (options.preset === 'core') applyCoreStorageValues(options);
  else applyDemoStorageValues(options);
};

const renderSetupEnvironment = (source, values) => {
  let result = source;
  for (const [key, value] of values) result = setEnvValue(result, key, value);
  if (!result.endsWith('\n')) result += '\n';
  assertNoActivePlaceholders(result);
  return result;
};

export const createSetupEnvironment = ({
  appName,
  appSlug,
  preset,
  source,
  randomBytes = defaultRandomBytes,
  preserveConfiguredAdapters = false,
}) => {
  const current = readEnvAssignments(source);
  const setupOptions = {
    appName,
    appSlug,
    current,
    preset,
    preserveConfiguredAdapters,
    randomBytes,
  };
  const values = createBaseSetupValues(setupOptions);
  applyOptionalAdapterValues({ ...setupOptions, values });
  applyStorageValues({ ...setupOptions, values });
  return renderSetupEnvironment(source, values);
};

export const createCapabilitySelectionSource = (preset) => {
  const ids = capabilityIdsByPreset[validatePreset(preset)];
  return `/** Generated by \`pnpm setup\`; do not select a preset at runtime. */
export const ACTIVE_CAPABILITY_PRESET = '${preset}' as const;

export const ENABLED_CAPABILITY_IDS = [
${ids.map((id) => `  '${id}',`).join('\n')}
] as const;

const enabledCapabilities = new Set<string>(ENABLED_CAPABILITY_IDS);

export const isCapabilityEnabled = (capabilityId: string) =>
  enabledCapabilities.has(capabilityId);
`;
};

const isStrictWranglerRoot = (root, errors) =>
  Boolean(root) && root.type === 'object' && errors.length === 0;

const wranglerParseErrorSuffix = (errors) => {
  const details = errors
    .map((error) => printParseErrorCode(error.error))
    .join(', ');
  return details ? ` (${details})` : '';
};

const parseStrictWranglerTree = (source) => {
  const errors = [];
  const root = parseTree(source, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (isStrictWranglerRoot(root, errors)) return root;
  throw new Error(
    `wrangler.json must contain strict valid JSON${wranglerParseErrorSuffix(errors)}.`
  );
};

const topLevelPropertiesNamed = (root, name) =>
  (root.children ?? []).filter(
    (property) =>
      property.type === 'property' && property.children?.[0]?.value === name
  );

const hasOneStringProperty = (properties) =>
  properties.length === 1 && properties[0]?.children?.[1]?.type === 'string';

const parseWranglerConfig = (source) => {
  const root = parseStrictWranglerTree(source);
  const nameProperties = topLevelPropertiesNamed(root, 'name');
  if (!hasOneStringProperty(nameProperties)) {
    throw new Error(
      'wrangler.json must contain one top-level string name field for APP_SLUG setup.'
    );
  }
  return { name: getNodeValue(nameProperties[0].children[1]) };
};

export const createWranglerConfigSource = (source, appSlug) => {
  parseWranglerConfig(source);
  const edits = modify(source, ['name'], validateSlug(appSlug), {
    formattingOptions: { eol: '\n', insertSpaces: true, tabSize: 2 },
  });
  const next = applyEdits(source, edits);
  return next.endsWith('\n') ? next : `${next}\n`;
};

const readWranglerName = (source) => parseWranglerConfig(source).name;

const assertStableApplicationSlug = (assignments, options) => {
  const existing = assignments.get('APP_SLUG');
  if (existing && existing !== options.appSlug) {
    throw new Error(
      `Refusing to change APP_SLUG from ${existing} to ${options.appSlug}. APP_SLUG is durable after first deployment; use a fresh checkout before deployment or supply an explicit durable-data migration.`
    );
  }
};

const assertStableCapabilityPreset = (assignments, options) => {
  const existing = assignments.get('CAPABILITY_PRESET');
  if (presets.has(existing) && existing !== options.preset) {
    throw new Error(
      `Refusing to change CAPABILITY_PRESET from ${existing} to ${options.preset}. Preset selection changes the generated capability selection and runtime gates; use a fresh checkout for a different preset.`
    );
  }
};

const assertSafeRerun = (assignments, options) => {
  const version = assignments.get('SETUP_VERSION');
  if (version !== undefined && version !== '' && version !== '1') {
    throw new Error(
      `Unsupported SETUP_VERSION ${version}; update the setup tool before changing this environment.`
    );
  }
  assertStableApplicationSlug(assignments, options);
  assertStableCapabilityPreset(assignments, options);
};

export const writeFileAtomic = (
  filePath,
  contents,
  { fileSystem = fs, mode = 0o644, randomUuid = defaultRandomUuid } = {}
) => {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.setup-${process.pid}-${randomUuid()}`
  );
  try {
    fileSystem.writeFileSync(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original failure; a stale unique temporary file is inert.
    }
    throw error;
  }
};

const needsSetupPrompt = (options) => {
  if (options.yes) return false;
  if (!options.dryRun) return true;
  return missingSetupInputs(options).length > 0;
};

const openSetupPrompt = (options, input, output) => {
  if (!needsSetupPrompt(options)) return undefined;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'Setup cannot prompt without a TTY. Pass --yes with all required inputs, or use --dry-run with all required inputs.'
    );
  }
  return createInterface({ input, output });
};

const setupPaths = (cwd) => ({
  envPath: path.join(cwd, '.env'),
  examplePath: path.join(cwd, '.env.example'),
  selectionPath: path.join(
    cwd,
    'src/modules/kernel/domain/capability-selection.generated.ts'
  ),
  wranglerPath: path.join(cwd, 'wrangler.json'),
});

const readSetupEnvironmentSource = (paths, existed) =>
  fs.readFileSync(existed ? paths.envPath : paths.examplePath, 'utf8');

const setupPlanChanged = (...changes) => changes.some(Boolean);

const assertEstablishedWranglerIdentity = ({
  establishedSlug,
  existed,
  wranglerSource,
}) => {
  if (!existed || !establishedSlug) return;
  if (readWranglerName(wranglerSource) === establishedSlug) return;
  throw new Error(
    `Refusing setup because wrangler.json name does not match established APP_SLUG ${establishedSlug}. Reconcile the deployment identity explicitly before continuing.`
  );
};

const createSetupPlan = ({ cwd, options, randomBytes }) => {
  const paths = setupPaths(cwd);
  const existed = fs.existsSync(paths.envPath);
  const source = readSetupEnvironmentSource(paths, existed);
  const current = readEnvAssignments(source);
  if (existed) assertSafeRerun(current, options);
  const next = createSetupEnvironment({
    ...options,
    preserveConfiguredAdapters: existed,
    randomBytes,
    source,
  });
  const selectionSource = fs.readFileSync(paths.selectionPath, 'utf8');
  const nextSelection = createCapabilitySelectionSource(options.preset);
  const wranglerSource = fs.readFileSync(paths.wranglerPath, 'utf8');
  const establishedSlug = current.get('APP_SLUG');
  assertEstablishedWranglerIdentity({
    establishedSlug,
    existed,
    wranglerSource,
  });
  const nextWrangler = createWranglerConfigSource(
    wranglerSource,
    options.appSlug
  );
  const envChanged = next !== source || !existed;
  const selectionChanged = nextSelection !== selectionSource;
  const wranglerChanged = nextWrangler !== wranglerSource;
  return {
    ...paths,
    changed: setupPlanChanged(envChanged, selectionChanged, wranglerChanged),
    emailDeliveryEnabled:
      readEnvAssignments(next).get('EMAIL_DELIVERY_DISABLED') === 'false',
    envChanged,
    existed,
    next,
    nextSelection,
    nextWrangler,
    selectionChanged,
    selectionSource,
    wranglerChanged,
    wranglerSource,
  };
};

const printSetupPlan = (output, options, plan) => {
  output.write(
    `${options.dryRun ? 'Would configure' : 'Preparing'} ${options.preset} preset for ${options.appName} (${options.appSlug}).\n`
  );
  const storageStatus =
    options.preset === 'core'
      ? 'The object-storage capability is disabled.'
      : 'Local demo object storage is configured.';
  const emailStatus = plan.emailDeliveryEnabled
    ? 'enabled by the preserved adapter configuration'
    : 'disabled';
  output.write(`${storageStatus} Email delivery is ${emailStatus}.\n`);
  output.write('Generated secrets are never printed.\n');
};

const printDryRunResult = (output, plan) => {
  output.write(
    `${plan.changed ? 'Would update' : 'No changes for'} ${plan.envPath}.\n`
  );
  output.write(
    `${plan.selectionChanged ? 'Would update' : 'No changes for'} ${plan.selectionPath}.\n`
  );
  output.write(
    `${plan.wranglerChanged ? 'Would update' : 'No changes for'} ${plan.wranglerPath}.\n`
  );
};

const writeWranglerConfig = (plan, writeAtomic) => {
  if (!plan.wranglerChanged) return;
  writeAtomic(plan.wranglerPath, plan.nextWrangler, { mode: 0o644 });
};

const writeGeneratedSelection = (plan, writeAtomic) => {
  if (!plan.selectionChanged) return;
  writeAtomic(plan.selectionPath, plan.nextSelection, { mode: 0o644 });
};

const writePrivateEnvironment = (plan, writeAtomic) => {
  if (plan.envChanged) {
    writeAtomic(plan.envPath, plan.next, { mode: 0o600 });
    return;
  }
  if (fs.statSync(plan.envPath).mode & 0o077) {
    fs.chmodSync(plan.envPath, 0o600);
  }
};

const restoreGeneratedSelection = (plan, writeAtomic) => {
  if (!plan.selectionChanged) return;
  writeAtomic(plan.selectionPath, plan.selectionSource, { mode: 0o644 });
};

const restoreWranglerConfig = (plan, writeAtomic) => {
  if (!plan.wranglerChanged) return;
  writeAtomic(plan.wranglerPath, plan.wranglerSource, { mode: 0o644 });
};

const attemptPublicSetupRestore = (
  shouldRestore,
  restore,
  plan,
  writeAtomic
) => {
  if (!shouldRestore) return undefined;
  try {
    restore(plan, writeAtomic);
    return undefined;
  } catch (error) {
    return error;
  }
};

const restorePublicSetupFiles = (
  plan,
  writeAtomic,
  { selectionWritten, wranglerWritten }
) => {
  return [
    attemptPublicSetupRestore(
      selectionWritten,
      restoreGeneratedSelection,
      plan,
      writeAtomic
    ),
    attemptPublicSetupRestore(
      wranglerWritten,
      restoreWranglerConfig,
      plan,
      writeAtomic
    ),
  ].filter(Boolean);
};

const writeSetupPlan = (plan, writeAtomic) => {
  let selectionWritten = false;
  let wranglerWritten = false;
  try {
    writeWranglerConfig(plan, writeAtomic);
    wranglerWritten = plan.wranglerChanged;
    writeGeneratedSelection(plan, writeAtomic);
    selectionWritten = plan.selectionChanged;
    writePrivateEnvironment(plan, writeAtomic);
  } catch (error) {
    const rollbackErrors = restorePublicSetupFiles(plan, writeAtomic, {
      selectionWritten,
      wranglerWritten,
    });
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Setup failed and one or more public configuration files could not be restored.'
      );
    }
    throw error;
  }
};

const writeSetupUsage = (output) => {
  output.write(`${usage}\n`);
  return { changed: false, dryRun: false, help: true };
};

const promptFunction = (readline) =>
  readline ? readline.question.bind(readline) : undefined;

const closeSetupPrompt = (readline) => {
  readline?.close();
};

export const runSetup = async ({
  argv,
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  randomBytes = defaultRandomBytes,
  writeAtomic = writeFileAtomic,
}) => {
  const parsed = parseSetupArguments(argv);
  if (parsed.help) return writeSetupUsage(output);

  const readline = openSetupPrompt(parsed, input, output);

  try {
    const options = await resolveSetupOptions(parsed, promptFunction(readline));
    const plan = createSetupPlan({ cwd, options, randomBytes });
    printSetupPlan(output, options, plan);
    if (options.dryRun) {
      printDryRunResult(output, plan);
      return { changed: plan.changed, dryRun: true, envPath: plan.envPath };
    }
    writeSetupPlan(plan, writeAtomic);
    output.write(
      `${plan.changed ? 'Configured' : 'No changes for'} ${options.preset} preset at ${plan.envPath}.\n`
    );
    return { changed: plan.changed, dryRun: false, envPath: plan.envPath };
  } finally {
    closeSetupPrompt(readline);
  }
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  runSetup({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
