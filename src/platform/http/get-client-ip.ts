import type {
  RuntimeProfile,
  TrustedClientIpAdapterKind,
} from '@/platform/runtime/runtime-profile';

const normalizeIpv4 = (value: string) => {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN
  );
  if (octets.some((part) => !Number.isInteger(part) || part > 255)) {
    return undefined;
  }
  return octets.join('.');
};

const expandIpv4Tail = (value: string) => {
  const separator = value.lastIndexOf(':');
  const ipv4 = normalizeIpv4(value.slice(separator + 1));
  if (separator < 0 || !ipv4) return undefined;
  const octets = ipv4.split('.').map(Number);
  const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
  const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
  return `${value.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
};

const prepareIpv6Halves = (value: string) => {
  const expanded = value.includes('.') ? expandIpv4Tail(value) : value;
  if (!expanded || expanded.includes('%')) return undefined;
  const halves = expanded.split('::');
  if (halves.length > 2) return undefined;
  return halves;
};

const parseIpv6Half = (half: string) => {
  if (half.length === 0) return [];
  const parts = half.split(':');
  if (!parts.every((part) => /^[\dA-Fa-f]{1,4}$/u.test(part))) {
    return undefined;
  }
  return parts.map((part) => parseInt(part, 16));
};

const parseIpv6Groups = (value: string) => {
  const halves = prepareIpv6Halves(value);
  if (!halves) return undefined;
  const left = parseIpv6Half(halves[0] ?? '');
  const right = parseIpv6Half(halves[1] ?? '');
  if (!left || !right) return undefined;
  const omitted = 8 - left.length - right.length;
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return undefined;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
};

const longestZeroRun = (groups: number[]) => {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    const start = index;
    while (groups[index] === 0) index += 1;
    const length = index - start;
    if (length > bestLength && length >= 2) {
      bestStart = start;
      bestLength = length;
    }
  }
  return { length: bestLength, start: bestStart };
};

const mappedIpv4FromGroups = (groups: number[]) => {
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return undefined;
};

const renderIpv6Groups = (groups: number[]) => {
  const rendered = groups.map((group) => group.toString(16));
  const run = longestZeroRun(groups);
  if (run.start < 0) return rendered.join(':');
  const left = rendered.slice(0, run.start).join(':');
  const right = rendered.slice(run.start + run.length).join(':');
  if (!left) return right ? `::${right}` : '::';
  return right ? `${left}::${right}` : `${left}::`;
};

const normalizeIpv6 = (value: string) => {
  const groups = parseIpv6Groups(value);
  if (!groups) return undefined;
  return mappedIpv4FromGroups(groups) ?? renderIpv6Groups(groups);
};

const validPort = (value: string) =>
  /^\d{1,5}$/u.test(value) && Number(value) <= 65_535;

const withoutOptionalPort = (value: string) => {
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
    if (!match || (match[2] && !validPort(match[2]))) return undefined;
    return match[1];
  }
  const separator = value.lastIndexOf(':');
  if (separator > 0 && value.indexOf(':') === separator) {
    const address = value.slice(0, separator);
    const port = value.slice(separator + 1);
    if (normalizeIpv4(address) && validPort(port)) return address;
  }
  return value;
};

/** Normalize an IP literal into a stable rate-limit identity. */
const normalizeClientIp = (candidate: string) => {
  const value = withoutOptionalPort(candidate.trim());
  if (!value) return undefined;
  return normalizeIpv4(value) ?? normalizeIpv6(value);
};

export type TrustedClientIpAdapter = Readonly<{
  kind: TrustedClientIpAdapterKind;
  resolve(request: Request): string | undefined;
}>;

export type TrustedClientIpAdapterOptions = Readonly<{
  runtimeProfile: RuntimeProfile;
  trustedProxyDepth: number | undefined;
}>;

const resolveTrustedProxyChain = (
  request: Request,
  depth: number | undefined
) => {
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 1) {
    return undefined;
  }

  const parts = (request.headers.get('X-Forwarded-For') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < depth) return undefined;
  return normalizeClientIp(parts[parts.length - depth] ?? '');
};

const resolveSingleHeader = (request: Request, header: string) => {
  const candidate = request.headers.get(header);
  if (!candidate || candidate.includes(',')) return undefined;
  return normalizeClientIp(candidate);
};

/**
 * Select the trusted client-IP source from the entrypoint-owned runtime
 * profile. Each adapter deliberately ignores every other platform's header:
 * Vercel owns `X-Vercel-Forwarded-For`, Cloudflare owns `CF-Connecting-IP`, and
 * self-hosted Node uses only its explicitly configured trusted XFF chain.
 *
 * The resolved identity is for abuse controls and diagnostics, never
 * authorization. Node deployments must make the origin reachable only through
 * the configured proxy chain. Vercel and Cloudflare headers are trustworthy
 * only when their managed runtime is the actual request entrypoint.
 */
export const createTrustedClientIpAdapter = ({
  runtimeProfile,
  trustedProxyDepth,
}: TrustedClientIpAdapterOptions): TrustedClientIpAdapter => {
  switch (runtimeProfile) {
    case 'node':
      return {
        kind: 'trusted-proxy-chain',
        resolve: (request) =>
          resolveTrustedProxyChain(request, trustedProxyDepth),
      };
    case 'vercel':
      return {
        kind: 'vercel-forwarded-for',
        resolve: (request) =>
          resolveSingleHeader(request, 'X-Vercel-Forwarded-For'),
      };
    case 'cloudflare':
      return {
        kind: 'cloudflare-connecting-ip',
        resolve: (request) => resolveSingleHeader(request, 'CF-Connecting-IP'),
      };
  }
};
