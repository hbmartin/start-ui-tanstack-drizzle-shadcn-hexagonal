import type { RuntimeProfile } from '../runtime/runtime-profile.js';

import { isProdRuntimeEnvironment, type RuntimeEnv } from './runtime.js';
import { isLocalhostUrl } from './url-security.js';

const readNonBlankString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseHttpUrl = (
  field: string,
  candidate: string,
  allowHostOnly: boolean
): URL => {
  let parsed: URL;
  try {
    parsed = new URL(allowHostOnly ? `https://${candidate}` : candidate);
  } catch {
    throw new TypeError(`${field} must be a valid HTTP(S) origin.`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError(`${field} must be a valid HTTP(S) origin.`);
  }
  return parsed;
};

const assertOriginOnly = (field: string, parsed: URL) => {
  const disallowedComponents = [
    parsed.username,
    parsed.password,
    parsed.pathname === '/' ? '' : parsed.pathname,
    parsed.search,
    parsed.hash,
  ];
  if (disallowedComponents.some(Boolean)) {
    throw new TypeError(
      `${field} must contain only an origin, without credentials, path, query, or fragment.`
    );
  }
};

const assertSecureTransport = (
  field: string,
  parsed: URL,
  isProduction: boolean
) => {
  const isAllowedLocalHttp =
    !isProduction &&
    parsed.protocol === 'http:' &&
    isLocalhostUrl(parsed.origin);
  if (parsed.protocol !== 'https:' && !isAllowedLocalHttp) {
    throw new TypeError(
      `${field} must use HTTPS; HTTP is allowed only for localhost in local and test environments.`
    );
  }
};

const parseExactOrigin = (
  field: string,
  value: unknown,
  isProduction: boolean,
  allowHostOnly: boolean
): string => {
  const candidate = readNonBlankString(value);
  if (!candidate) throw new TypeError(`${field} is required.`);

  const parsed = parseHttpUrl(field, candidate, allowHostOnly);
  assertOriginOnly(field, parsed);
  assertSecureTransport(field, parsed, isProduction);

  return parsed.origin;
};

const selectProductionOrigin = (
  env: RuntimeEnv,
  runtimeProfile: RuntimeProfile
) => {
  if (runtimeProfile === 'vercel') {
    const productionUrl = readNonBlankString(env.VERCEL_PROJECT_PRODUCTION_URL);
    if (productionUrl) {
      return {
        allowHostOnly: true,
        field: 'VERCEL_PROJECT_PRODUCTION_URL',
        value: productionUrl,
      };
    }
    return {
      allowHostOnly: true,
      field: 'VERCEL_URL',
      value: env.VERCEL_URL,
    };
  }

  return {
    allowHostOnly: false,
    field: 'APP_DOMAIN',
    value: env.APP_DOMAIN,
  };
};

/**
 * Resolve the one canonical application origin from a trusted runtime profile.
 * Production Node and Cloudflare deployments use APP_DOMAIN; Vercel owns its
 * documented system-variable precedence. Browser/local parsing without a
 * profile consumes the already-selected VITE_BASE_URL.
 */
export const resolveCanonicalOrigin = (
  env: RuntimeEnv,
  runtimeProfile?: RuntimeProfile
): string => {
  const isProduction = isProdRuntimeEnvironment(env);
  const selected =
    isProduction && runtimeProfile
      ? selectProductionOrigin(env, runtimeProfile)
      : {
          allowHostOnly: false,
          field: 'VITE_BASE_URL',
          value: env.VITE_BASE_URL,
        };

  return parseExactOrigin(
    selected.field,
    selected.value,
    isProduction,
    selected.allowHostOnly
  );
};
