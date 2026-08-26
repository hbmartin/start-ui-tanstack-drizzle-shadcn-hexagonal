import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => {
  throw new Error(`Runtime verification environment failed: ${message}`);
};

export const parseGeneratedCapabilityPreset = (source) => {
  const match =
    /export const ACTIVE_CAPABILITY_PRESET = '(core|demo)' as const;/u.exec(
      source
    );
  if (!match) fail('could not read the generated capability preset');
  return match[1];
};

export const readGeneratedCapabilityPreset = (root) =>
  parseGeneratedCapabilityPreset(
    fs.readFileSync(
      path.join(
        root,
        'src/modules/kernel/domain/capability-selection.generated.ts'
      ),
      'utf8'
    )
  );

const buildToolEnvironment = () => {
  const inheritedNames = [
    'CI',
    'COLORTERM',
    'FORCE_COLOR',
    'HOME',
    'LANG',
    'LC_ALL',
    'NO_COLOR',
    'PATH',
    'PNPM_HOME',
    'SHELL',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'TZ',
  ];
  return Object.fromEntries(
    inheritedNames.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]]
    )
  );
};

export const createVerificationEnvironment = ({
  appPort,
  databasePort,
  preset,
  profile = 'node',
  redisPort,
}) => {
  const origin = `http://localhost:${appPort}`;
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  return {
    ...buildToolEnvironment(),
    APP_NAME: 'Start UI Runtime Verification',
    APP_SLUG: 'start-ui-runtime-verification',
    AUTH_RATE_LIMIT_HMAC_SECRET: randomBytes(48).toString('base64url'),
    AUTH_SECRET: randomBytes(48).toString('base64url'),
    CAPABILITY_PRESET: preset,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    DATABASE_DRIVER: 'node-pg',
    DATABASE_MIGRATION_DRIVER: 'node-pg',
    DATABASE_MIGRATION_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    EMAIL_DELIVERY_DISABLED: 'true',
    EMAIL_FROM: 'Start UI Runtime Verification <noreply@example.test>',
    EMAIL_SERVER: '',
    GITHUB_CLIENT_ID: 'runtime-verification-github-client-id',
    GITHUB_CLIENT_SECRET: 'runtime-verification-github-client-secret',
    LOGGER_CONSOLE_MIRROR: 'true',
    NODE_ENV: 'production',
    OTEL_LOCAL_SQLITE_ENABLED: 'false',
    PORT: String(appPort),
    SKIP_ENV_VALIDATION: 'false',
    START_UI_DISABLE_CLOUD_BUILD_PLUGINS: 'true',
    START_UI_RUNTIME_PROFILE: profile,
    TRUSTED_PROXY_DEPTH: '1',
    UPSTASH_REDIS_REST_TOKEN: 'runtime-verification-token',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redisPort}`,
    VITE_AUTH_SIGNUP_ENABLED: 'false',
    VITE_BASE_URL: origin,
    VITE_ENV_COLOR: 'plum',
    VITE_ENV_EMOJI: '🧪',
    VITE_ENV_NAME: 'RUNTIME-VERIFY',
    VITE_OTEL_BROWSER_ENABLED: 'false',
    VITE_PORT: String(appPort),
    ...(preset === 'demo'
      ? {
          S3_ACCESS_KEY_ID: 'runtime-verification-access-key',
          S3_BUCKET_NAME: 'runtime-verification',
          S3_FORCE_PATH_STYLE: 'true',
          S3_HOST: '127.0.0.1:9000',
          S3_SECRET_ACCESS_KEY: 'runtime-verification-secret-key',
          S3_SECURE: 'false',
          VITE_S3_BUCKET_PUBLIC_URL:
            'http://127.0.0.1:9000/runtime-verification',
        }
      : {}),
  };
};
