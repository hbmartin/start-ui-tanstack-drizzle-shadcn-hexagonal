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

/**
 * Best-effort client IP extraction from common proxy headers.
 *
 * `X-Forwarded-For` is a comma-separated trail where each proxy appends the
 * address it saw. Only the entries appended by *trusted* proxies are
 * meaningful; everything to the left can be forged by the original caller.
 * Callers pass `trustedProxyDepth` (the number of trusted proxy hops in front
 * of the app, configured via `TRUSTED_PROXY_DEPTH`) so the genuine client IP is
 * read `depth` hops from the end rather than the attacker-controllable
 * leftmost entry.
 *
 * This function is intentionally pure and free of module/config imports so it
 * can live in `src/platform`: the configured depth is injected by callers.
 *
 * IMPORTANT: the result is best-effort defense-in-depth (rate limiting,
 * abuse logging) only. It MUST NOT be used for authorization decisions, and it
 * is only trustworthy when a known edge/proxy sets these headers and
 * `trustedProxyDepth` matches that topology. Returns `undefined` when no
 * candidate header is present or the configured trusted hop cannot be verified.
 */
export function getClientIp(
  request: Request,
  options: { trustedProxyDepth?: number } = {}
): string | undefined {
  const depth = options.trustedProxyDepth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 1) return undefined;

  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const parts = forwardedFor
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length > 0) {
      // Walk `depth` hops back from the end. With one trusted proxy (depth=1)
      // that is the rightmost entry, which only the immediate trusted proxy can
      // append; entries to its left are attacker-supplied and ignored. If the
      // configured hop is missing, fail closed instead of trusting the leftmost
      // value.
      if (parts.length < depth) return undefined;
      return normalizeClientIp(parts[parts.length - depth] ?? '');
    }
  }

  // Fallbacks for edge topologies that don't populate X-Forwarded-For. These
  // are single-value headers set by the immediate edge (no hop trail to walk),
  // so they are only meaningful when the app actually sits behind that edge:
  //   - X-Real-IP: set by nginx and many reverse proxies. Vercel also sets it,
  //     but Vercel additionally sets X-Forwarded-For, so the depth-checked XFF
  //     path above wins on Vercel and this fallback is not reached there.
  //   - CF-Connecting-IP: Cloudflare sets this to the original client IP on
  //     every proxied request; behind Cloudflare it is the reliable source.
  // If the origin is reachable directly (the edge can be bypassed by hitting the
  // app's IP/host), a caller can forge either header, exactly like XFF. The
  // result therefore stays best-effort defense-in-depth (rate limiting, abuse
  // logging) and MUST NOT drive authorization. A deployment that does not
  // terminate behind nginx/Vercel/Cloudflare should not rely on these values.
  const realIp = normalizeClientIp(request.headers.get('X-Real-IP') ?? '');
  if (realIp) return realIp;

  const cfConnectingIp = normalizeClientIp(
    request.headers.get('CF-Connecting-IP') ?? ''
  );
  if (cfConnectingIp) return cfConnectingIp;

  return undefined;
}
