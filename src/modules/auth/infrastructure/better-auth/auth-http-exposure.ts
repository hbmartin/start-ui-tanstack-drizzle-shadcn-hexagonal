/**
 * Deny-by-default HTTP policy for Better Auth's catch-all route.
 *
 * The application deliberately exposes only the provider endpoints needed to
 * begin and complete authentication. Account administration, session
 * revocation, sign-out, signup, password reset, and other mutations remain
 * unexposed until app-owned use cases can enforce authorization and durable
 * audit policy. Focused in-process provider adapters remain separately scoped.
 */

import type { TrustedClientIpAdapter } from '@/platform/http/get-client-ip';

const BETTER_AUTH_BASE_PATH = '/api/auth';
const MAX_AUTH_HTTP_BODY_BYTES = 8 * 1024;
export const TRUSTED_AUTH_CLIENT_IP_HEADER = 'x-start-ui-client-ip';

export const withTrustedAuthClientIp = (
  request: Request,
  adapter: TrustedClientIpAdapter
) => {
  const trustedRequest = request.clone();
  trustedRequest.headers.delete(TRUSTED_AUTH_CLIENT_IP_HEADER);
  const clientIp = adapter.resolve(request);
  if (clientIp) {
    trustedRequest.headers.set(TRUSTED_AUTH_CLIENT_IP_HEADER, clientIp);
  }
  return trustedRequest;
};

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasJsonMediaType = (request: Request) => {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === 'application/json';
};

const hasValidDeclaredBodyLength = (request: Request) => {
  const contentLength = request.headers.get('content-length');
  if (!contentLength) return true;
  if (!/^\d+$/u.test(contentLength)) return false;
  return Number(contentLength) <= MAX_AUTH_HTTP_BODY_BYTES;
};

const readBoundedBodyBytes = async (
  request: Request
): Promise<Uint8Array | undefined> => {
  const reader = request.clone().body?.getReader();
  if (!reader) return undefined;

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_AUTH_HTTP_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const parseJsonRecord = (bytes: Uint8Array): JsonRecord | undefined => {
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  );
  return isJsonRecord(parsed) ? parsed : undefined;
};

const readBoundedJsonBody = async (
  request: Request
): Promise<JsonRecord | undefined> => {
  if (!hasJsonMediaType(request) || !hasValidDeclaredBodyLength(request)) {
    return undefined;
  }

  try {
    const bytes = await readBoundedBodyBytes(request);
    if (!bytes) return undefined;
    return parseJsonRecord(bytes);
  } catch {
    return undefined;
  }
};

const hasCanonicalPath = (request: Request, pathname: string) => {
  const requestPathname = new URL(request.url).pathname;
  return (
    requestPathname === pathname &&
    !requestPathname.includes('%') &&
    !requestPathname.includes('//')
  );
};

export const isAllowedBetterAuthHttpRequest = async (
  request: Request
): Promise<boolean> => {
  if (
    request.method === 'GET' &&
    hasCanonicalPath(request, `${BETTER_AUTH_BASE_PATH}/callback/github`)
  ) {
    return true;
  }

  if (request.method !== 'POST') return false;
  const isOtpSend = hasCanonicalPath(
    request,
    `${BETTER_AUTH_BASE_PATH}/email-otp/send-verification-otp`
  );
  const isOtpSignIn = hasCanonicalPath(
    request,
    `${BETTER_AUTH_BASE_PATH}/sign-in/email-otp`
  );
  const isSocialSignIn = hasCanonicalPath(
    request,
    `${BETTER_AUTH_BASE_PATH}/sign-in/social`
  );
  if (!isOtpSend && !isOtpSignIn && !isSocialSignIn) return false;

  const body = await readBoundedJsonBody(request);
  if (!body) return false;

  if (isOtpSend) return body.type === 'sign-in';

  if (isOtpSignIn) return true;

  if (isSocialSignIn) {
    return body.provider === 'github' && body.requestSignUp !== true;
  }

  return false;
};

export const isBlockedBetterAuthHttpRequest = async (
  request: Request
): Promise<boolean> => !(await isAllowedBetterAuthHttpRequest(request));
