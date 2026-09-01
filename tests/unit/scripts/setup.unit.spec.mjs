import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCapabilitySelectionSource,
  createSetupEnvironment,
  createWranglerConfigSource,
  parseSetupArguments,
  readEnvAssignments,
  resolveSetupOptions,
  runSetup,
  writeFileAtomic,
} from '../../../scripts/setup.mjs';

const temporaryDirectories = [];
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-setup-'));
  temporaryDirectories.push(directory);
  fs.copyFileSync('.env.example', path.join(directory, '.env.example'));
  const selectionPath = path.join(
    directory,
    'src/modules/kernel/domain/capability-selection.generated.ts'
  );
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  fs.copyFileSync(
    'src/modules/kernel/domain/capability-selection.generated.ts',
    selectionPath
  );
  fs.copyFileSync('wrangler.json', path.join(directory, 'wrangler.json'));
  return directory;
};
const deterministicRandom = (size) => Buffer.alloc(size, 7);
const outputSink = () => {
  let value = '';
  return {
    isTTY: false,
    write(chunk) {
      value += chunk;
    },
    value: () => value,
  };
};
const failAtomicWriteTo = (target) => (filePath, contents, options) => {
  if (filePath === target) {
    throw new Error(`simulated write failure for ${path.basename(target)}`);
  }
  writeFileAtomic(filePath, contents, options);
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('setup arguments', () => {
  it('parses deterministic long options and rejects unknown values', () => {
    expect(
      parseSetupArguments([
        '--preset=core',
        '--app-name',
        'Acme',
        '--app-slug=acme-app',
        '--yes',
        '--dry-run',
      ])
    ).toMatchObject({
      appName: 'Acme',
      appSlug: 'acme-app',
      dryRun: true,
      preset: 'core',
      yes: true,
    });
    expect(() => parseSetupArguments(['--unknown=value'])).toThrow(
      'Unknown setup option'
    );
  });

  it('has no default preset and requires every noninteractive input', async () => {
    await expect(resolveSetupOptions({ yes: true }, undefined)).rejects.toThrow(
      '--yes requires'
    );
    await expect(
      resolveSetupOptions(
        { appName: 'Acme', appSlug: 'acme', yes: false },
        undefined
      )
    ).rejects.toThrow('interactive terminal');
  });

  it('prompts for each missing value and confirmation', async () => {
    const answers = ['core', 'Acme', 'acme-app', 'yes'];
    const result = await resolveSetupOptions(
      { dryRun: false, help: false, yes: false },
      async () => answers.shift()
    );
    expect(result).toMatchObject({
      appName: 'Acme',
      appSlug: 'acme-app',
      preset: 'core',
    });
  });

  it('rejects control characters in the presentation name', async () => {
    await expect(
      resolveSetupOptions(
        {
          appName: 'Acme\r\nBcc: victim@example.com',
          appSlug: 'acme-app',
          dryRun: true,
          preset: 'core',
          yes: true,
        },
        undefined
      )
    ).rejects.toThrow('without control characters');
  });
});

describe('setup environment generation', () => {
  it('creates distinct strong secrets and disables optional core adapters', () => {
    const source = fs.readFileSync('.env.example', 'utf8');
    let fill = 1;
    const result = createSetupEnvironment({
      appName: 'Acme Cloud',
      appSlug: 'acme-cloud',
      preset: 'core',
      randomBytes: (size) => Buffer.alloc(size, fill++),
      source,
    });
    const values = readEnvAssignments(result);
    expect(values.get('APP_NAME')).toBe('Acme Cloud');
    expect(values.get('APP_SLUG')).toBe('acme-cloud');
    expect(values.get('CAPABILITY_PRESET')).toBe('core');
    expect(values.get('AUTH_SECRET').length).toBeGreaterThanOrEqual(64);
    expect(
      values.get('AUTH_RATE_LIMIT_HMAC_SECRET').length
    ).toBeGreaterThanOrEqual(64);
    expect(values.get('AUTH_RATE_LIMIT_HMAC_SECRET')).not.toBe(
      values.get('AUTH_SECRET')
    );
    expect(values.get('EMAIL_DELIVERY_DISABLED')).toBe('true');
    expect(values.get('RESEND_API_KEY')).toBe('');
    expect(values.get('S3_ACCESS_KEY_ID')).toBe('');
    expect(values.get('VITE_S3_BUCKET_PUBLIC_URL')).toBe('');
    expect(result).not.toMatch(/^[A-Z][A-Z0-9_]*=.*REPLACE ME/mu);
  });

  it('preserves valid secrets on idempotent reruns', () => {
    const source = fs.readFileSync('.env.example', 'utf8');
    const first = createSetupEnvironment({
      appName: 'Acme',
      appSlug: 'acme-app',
      preset: 'demo',
      randomBytes: deterministicRandom,
      source,
    });
    const second = createSetupEnvironment({
      appName: 'Acme',
      appSlug: 'acme-app',
      preset: 'demo',
      preserveConfiguredAdapters: true,
      randomBytes: () => Buffer.alloc(48, 9),
      source: first,
    });
    expect(second).toBe(first);
    expect(readEnvAssignments(second).get('S3_ACCESS_KEY_ID')).not.toBe('');
  });

  it('generates static core and demo capability selections', () => {
    expect(createCapabilitySelectionSource('core')).not.toContain("'book'");
    expect(createCapabilitySelectionSource('core')).not.toContain("'genre'");
    expect(createCapabilitySelectionSource('demo')).toContain("'book'");
    expect(createCapabilitySelectionSource('demo')).toContain("'genre'");
  });

  it('rejects duplicate active keys before changing anything', () => {
    expect(() => readEnvAssignments('APP_NAME="A"\nAPP_NAME="B"\n')).toThrow(
      'Duplicate active environment key: APP_NAME'
    );
  });

  it('preserves explicitly configured optional adapters on rerun', () => {
    const configured = fs
      .readFileSync('.env.example', 'utf8')
      .replace(
        '# EMAIL_SERVER="smtp://127.0.0.1:1025"',
        'EMAIL_SERVER="smtp://127.0.0.1:1025"'
      );
    const result = createSetupEnvironment({
      appName: 'Acme',
      appSlug: 'acme-app',
      preset: 'core',
      preserveConfiguredAdapters: true,
      randomBytes: deterministicRandom,
      source: configured,
    });
    const values = readEnvAssignments(result);
    expect(values.get('EMAIL_SERVER')).toBe('smtp://127.0.0.1:1025');
    expect(values.get('EMAIL_DELIVERY_DISABLED')).toBe('false');
    expect(values.get('S3_ACCESS_KEY_ID')).toBe('');
    expect(values.get('S3_HOST')).toBe('');
    expect(values.get('VITE_S3_BUCKET_PUBLIC_URL')).toBe('');
  });

  it('preserves credentials and configured exporter/email values on rerun', () => {
    const configured = fs
      .readFileSync('.env.example', 'utf8')
      .replace(
        'DOCKER_DATABASE_PASSWORD="startui"',
        'DOCKER_DATABASE_PASSWORD="short-db-password"'
      )
      .replace(
        'DOCKER_MINIO_PASSWORD="minioadmin"',
        'DOCKER_MINIO_PASSWORD="short-minio-password"'
      )
      .replace(
        'S3_ACCESS_KEY_ID="startui-access-key"',
        'S3_ACCESS_KEY_ID="ABCDEFGHIJKLMNOPQRST"'
      )
      .replace(
        'S3_SECRET_ACCESS_KEY="startui-secret-key"',
        'S3_SECRET_ACCESS_KEY="existing-s3-secret"'
      )
      .replace('RESEND_API_KEY="REPLACE ME"', 'RESEND_API_KEY="re_configured"')
      .replace(
        'EMAIL_FROM="Start UI <noreply@example.com>"',
        'EMAIL_FROM="Acme <mail@verified.example>"'
      )
      .replace(
        'HONEYCOMB_API_KEY="REPLACE ME"',
        'HONEYCOMB_API_KEY="configured-honeycomb-key"'
      );
    const result = createSetupEnvironment({
      appName: 'Acme',
      appSlug: 'acme-app',
      preset: 'demo',
      preserveConfiguredAdapters: true,
      randomBytes: deterministicRandom,
      source: configured,
    });
    const values = readEnvAssignments(result);

    expect(values.get('DOCKER_DATABASE_PASSWORD')).toBe('short-db-password');
    expect(values.get('DOCKER_MINIO_PASSWORD')).toBe('short-minio-password');
    expect(values.get('S3_ACCESS_KEY_ID')).toBe('ABCDEFGHIJKLMNOPQRST');
    expect(values.get('S3_SECRET_ACCESS_KEY')).toBe('existing-s3-secret');
    expect(values.get('RESEND_API_KEY')).toBe('re_configured');
    expect(values.get('EMAIL_FROM')).toBe('Acme <mail@verified.example>');
    expect(values.get('HONEYCOMB_OTLP_ENDPOINT')).toBe(
      'https://api.honeycomb.io'
    );
    expect(values.get('HONEYCOMB_API_KEY')).toBe('configured-honeycomb-key');
  });
});

describe('setup Worker identity generation', () => {
  it('uses APP_SLUG as the source-controlled Worker name', () => {
    const source = fs.readFileSync('wrangler.json', 'utf8');
    const generated = createWranglerConfigSource(source, 'acme-cloud');
    expect(generated).toContain('"name": "acme-cloud"');
    expect(generated).not.toContain('"name": "start-ui-web"');
  });

  it('rejects an ambiguous or missing Worker name field', () => {
    expect(() => createWranglerConfigSource('{}\n', 'acme-cloud')).toThrow(
      'top-level'
    );
    const nestedName = createWranglerConfigSource(
      '{\n  "name": "root",\n  "workflow": { "name": "nested" }\n}\n',
      'acme-cloud'
    );
    expect(JSON.parse(nestedName)).toEqual({
      name: 'acme-cloud',
      workflow: { name: 'nested' },
    });
    expect(() =>
      createWranglerConfigSource(
        '{\n  "name": "one",\n  "name": "two"\n}\n',
        'acme-cloud'
      )
    ).toThrow('one top-level');
    expect(() =>
      createWranglerConfigSource('{ "name": "broken", }\n', 'acme-cloud')
    ).toThrow('strict valid JSON');
  });
});

describe('setup filesystem behavior', () => {
  const argumentsFor = (preset, extra = []) => [
    `--preset=${preset}`,
    '--app-name=Acme',
    '--app-slug=acme-app',
    '--yes',
    ...extra,
  ];

  it('does not create or update .env during dry-run', async () => {
    const cwd = fixture();
    const output = outputSink();
    const selectionPath = path.join(
      cwd,
      'src/modules/kernel/domain/capability-selection.generated.ts'
    );
    const selectionBefore = fs.readFileSync(selectionPath, 'utf8');
    const wranglerPath = path.join(cwd, 'wrangler.json');
    const wranglerBefore = fs.readFileSync(wranglerPath, 'utf8');
    const result = await runSetup({
      argv: argumentsFor('core', ['--dry-run']),
      cwd,
      input: { isTTY: false },
      output,
      randomBytes: deterministicRandom,
    });
    expect(result).toMatchObject({ changed: true, dryRun: true });
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(fs.readFileSync(selectionPath, 'utf8')).toBe(selectionBefore);
    expect(fs.readFileSync(wranglerPath, 'utf8')).toBe(wranglerBefore);
    expect(output.value()).not.toContain(
      Buffer.alloc(48, 7).toString('base64url')
    );
  });

  it('creates a private .env and becomes byte-idempotent', async () => {
    const cwd = fixture();
    const output = outputSink();
    const first = await runSetup({
      argv: argumentsFor('demo'),
      cwd,
      input: { isTTY: false },
      output,
      randomBytes: deterministicRandom,
    });
    const envPath = path.join(cwd, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const second = await runSetup({
      argv: argumentsFor('demo'),
      cwd,
      input: { isTTY: false },
      output,
      randomBytes: () => Buffer.alloc(48, 9),
    });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(content);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(cwd, 'wrangler.json'), 'utf8')).toContain(
      '"name": "acme-app"'
    );
  });

  it('writes the generated core selection without demo capabilities', async () => {
    const cwd = fixture();
    await runSetup({
      argv: argumentsFor('core'),
      cwd,
      input: { isTTY: false },
      output: outputSink(),
      randomBytes: deterministicRandom,
    });
    const selection = fs.readFileSync(
      path.join(
        cwd,
        'src/modules/kernel/domain/capability-selection.generated.ts'
      ),
      'utf8'
    );
    expect(selection).toContain("ACTIVE_CAPABILITY_PRESET = 'core'");
    expect(selection).not.toContain("'book'");
    expect(selection).not.toContain("'genre'");
    expect(
      fs.statSync(
        path.join(
          cwd,
          'src/modules/kernel/domain/capability-selection.generated.ts'
        )
      ).mode & 0o777
    ).toBe(0o644);
  });

  it('refuses to change an established slug or preset', async () => {
    const cwd = fixture();
    const output = outputSink();
    await runSetup({
      argv: argumentsFor('demo'),
      cwd,
      input: { isTTY: false },
      output,
      randomBytes: deterministicRandom,
    });
    await expect(
      runSetup({
        argv: [
          '--preset=demo',
          '--app-name=Acme',
          '--app-slug=renamed-app',
          '--yes',
        ],
        cwd,
        input: { isTTY: false },
        output,
        randomBytes: deterministicRandom,
      })
    ).rejects.toThrow('Refusing to change APP_SLUG');
    await expect(
      runSetup({
        argv: argumentsFor('core'),
        cwd,
        input: { isTTY: false },
        output,
        randomBytes: deterministicRandom,
      })
    ).rejects.toThrow('Refusing to change CAPABILITY_PRESET');
  });

  it('protects an established slug even without SETUP_VERSION', async () => {
    const cwd = fixture();
    fs.copyFileSync(path.join(cwd, '.env.example'), path.join(cwd, '.env'));
    await expect(
      runSetup({
        argv: argumentsFor('demo'),
        cwd,
        input: { isTTY: false },
        output: outputSink(),
        randomBytes: deterministicRandom,
      })
    ).rejects.toThrow('Refusing to change APP_SLUG');
  });

  it('refuses to hide divergence between durable and Worker identity', async () => {
    const cwd = fixture();
    await runSetup({
      argv: argumentsFor('demo'),
      cwd,
      input: { isTTY: false },
      output: outputSink(),
      randomBytes: deterministicRandom,
    });
    const wranglerPath = path.join(cwd, 'wrangler.json');
    fs.writeFileSync(
      wranglerPath,
      createWranglerConfigSource(
        fs.readFileSync(wranglerPath, 'utf8'),
        'different-worker'
      )
    );
    await expect(
      runSetup({
        argv: argumentsFor('demo'),
        cwd,
        input: { isTTY: false },
        output: outputSink(),
        randomBytes: deterministicRandom,
      })
    ).rejects.toThrow('does not match established APP_SLUG');
  });

  it('rejects unsupported setup versions without changing either file', async () => {
    const cwd = fixture();
    const envPath = path.join(cwd, '.env');
    const selectionPath = path.join(
      cwd,
      'src/modules/kernel/domain/capability-selection.generated.ts'
    );
    const unsupported = `${fs.readFileSync(path.join(cwd, '.env.example'), 'utf8')}\nSETUP_VERSION="2"\n`;
    fs.writeFileSync(envPath, unsupported, { mode: 0o600 });
    const selectionBefore = fs.readFileSync(selectionPath, 'utf8');

    await expect(
      runSetup({
        argv: argumentsFor('demo'),
        cwd,
        input: { isTTY: false },
        output: outputSink(),
        randomBytes: deterministicRandom,
      })
    ).rejects.toThrow('Unsupported SETUP_VERSION 2');

    expect(fs.readFileSync(envPath, 'utf8')).toBe(unsupported);
    expect(fs.readFileSync(selectionPath, 'utf8')).toBe(selectionBefore);
  });

  it('tightens an existing env file mode on a no-op rerun', async () => {
    const cwd = fixture();
    const output = outputSink();
    await runSetup({
      argv: argumentsFor('demo'),
      cwd,
      input: { isTTY: false },
      output,
      randomBytes: deterministicRandom,
    });
    const envPath = path.join(cwd, '.env');
    fs.chmodSync(envPath, 0o644);
    await runSetup({
      argv: argumentsFor('demo'),
      cwd,
      input: { isTTY: false },
      output,
      randomBytes: deterministicRandom,
    });
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('restores the generated selection when the env write fails', async () => {
    const cwd = fixture();
    const selectionPath = path.join(
      cwd,
      'src/modules/kernel/domain/capability-selection.generated.ts'
    );
    const selectionBefore = fs.readFileSync(selectionPath, 'utf8');
    const wranglerPath = path.join(cwd, 'wrangler.json');
    const wranglerBefore = fs.readFileSync(wranglerPath, 'utf8');

    await expect(
      runSetup({
        argv: argumentsFor('core'),
        cwd,
        input: { isTTY: false },
        output: outputSink(),
        randomBytes: deterministicRandom,
        writeAtomic: failAtomicWriteTo(path.join(cwd, '.env')),
      })
    ).rejects.toThrow('simulated write failure for .env');

    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(fs.readFileSync(selectionPath, 'utf8')).toBe(selectionBefore);
    expect(fs.readFileSync(wranglerPath, 'utf8')).toBe(wranglerBefore);
  });

  it('does not run rollback writes when the first public write fails', async () => {
    const cwd = fixture();
    const wranglerPath = path.join(cwd, 'wrangler.json');
    const wranglerBefore = fs.readFileSync(wranglerPath, 'utf8');

    await expect(
      runSetup({
        argv: argumentsFor('core'),
        cwd,
        input: { isTTY: false },
        output: outputSink(),
        randomBytes: deterministicRandom,
        writeAtomic: failAtomicWriteTo(wranglerPath),
      })
    ).rejects.toThrow('simulated write failure for wrangler.json');

    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(fs.readFileSync(wranglerPath, 'utf8')).toBe(wranglerBefore);
  });

  it('restores Worker identity when the capability selection write fails', async () => {
    const cwd = fixture();
    const selectionPath = path.join(
      cwd,
      'src/modules/kernel/domain/capability-selection.generated.ts'
    );
    const selectionBefore = fs.readFileSync(selectionPath, 'utf8');
    const wranglerPath = path.join(cwd, 'wrangler.json');
    const wranglerBefore = fs.readFileSync(wranglerPath, 'utf8');

    await expect(
      runSetup({
        argv: argumentsFor('core'),
        cwd,
        input: { isTTY: false },
        output: outputSink(),
        randomBytes: deterministicRandom,
        writeAtomic: failAtomicWriteTo(selectionPath),
      })
    ).rejects.toThrow(
      'simulated write failure for capability-selection.generated.ts'
    );

    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(fs.readFileSync(selectionPath, 'utf8')).toBe(selectionBefore);
    expect(fs.readFileSync(wranglerPath, 'utf8')).toBe(wranglerBefore);
  });

  it('leaves the destination intact when an atomic rename fails', () => {
    const cwd = fixture();
    const destination = path.join(cwd, '.env');
    fs.writeFileSync(destination, 'original\n');
    const fileSystem = {
      ...fs,
      renameSync() {
        throw new Error('simulated rename failure');
      },
    };
    expect(() =>
      writeFileAtomic(destination, 'replacement\n', {
        fileSystem,
        randomUuid: () => 'fixed',
      })
    ).toThrow('simulated rename failure');
    expect(fs.readFileSync(destination, 'utf8')).toBe('original\n');
    expect(
      fs.existsSync(path.join(cwd, '..env.setup-' + process.pid + '-fixed'))
    ).toBe(false);
  });
});
