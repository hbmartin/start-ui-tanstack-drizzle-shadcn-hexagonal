import { describe, expect, it } from 'vitest';

import { createTrustedClientIpAdapter } from '@/platform/http/get-client-ip';

const requestWith = (headers: Record<string, string>) =>
  new Request('http://localhost/api/telemetry/logs', { headers });

const adapter = (
  runtimeProfile: 'node' | 'vercel' | 'cloudflare',
  trustedProxyDepth = 1
) => createTrustedClientIpAdapter({ runtimeProfile, trustedProxyDepth });

describe('trusted client IP adapters', () => {
  it('defaults to depth 1: the rightmost X-Forwarded-For entry, ignoring spoofed leftmost entries', () => {
    const ip = adapter('node').resolve(
      requestWith({ 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('ignores additional attacker-supplied leftmost entries at depth 1', () => {
    const ip = adapter('node').resolve(
      requestWith({ 'X-Forwarded-For': '6.6.6.6, 1.2.3.4, 203.0.113.7' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('skips one more trusted hop at depth 2', () => {
    const ip = adapter('node', 2).resolve(
      requestWith({ 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('fails closed when the configured trusted hop is missing', () => {
    const ip = adapter('node', 5).resolve(
      requestWith({ 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' })
    );
    expect(ip).toBeUndefined();
  });

  it('fails closed for a single entry when depth requires more trusted hops', () => {
    expect(
      adapter('node', 3).resolve(
        requestWith({ 'X-Forwarded-For': '203.0.113.7' })
      )
    ).toBeUndefined();
  });

  it('fails closed when trustedProxyDepth is zero', () => {
    expect(
      adapter('node', 0).resolve(
        requestWith({ 'X-Forwarded-For': '203.0.113.7' })
      )
    ).toBeUndefined();
  });

  it('fails closed when trustedProxyDepth is not a safe integer', () => {
    expect(
      adapter('node', 1.5).resolve(
        requestWith({ 'X-Forwarded-For': '203.0.113.7' })
      )
    ).toBeUndefined();
    expect(
      adapter('node', Number.MAX_SAFE_INTEGER + 1).resolve(
        requestWith({ 'X-Forwarded-For': '203.0.113.7' })
      )
    ).toBeUndefined();
  });

  it('does not trust X-Real-IP in the Node profile', () => {
    expect(
      adapter('node').resolve(requestWith({ 'X-Real-IP': '192.0.2.1' }))
    ).toBeUndefined();
  });

  it('uses only X-Vercel-Forwarded-For in the Vercel profile', () => {
    const ip = adapter('vercel').resolve(
      requestWith({
        'CF-Connecting-IP': '192.0.2.1',
        'X-Forwarded-For': '198.51.100.1',
        'X-Real-IP': '198.51.100.2',
        'X-Vercel-Forwarded-For': '203.0.113.9',
      })
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('uses only CF-Connecting-IP in the Cloudflare profile', () => {
    const ip = adapter('cloudflare').resolve(
      requestWith({
        'CF-Connecting-IP': '203.0.113.7',
        'X-Forwarded-For': '198.51.100.1',
        'X-Real-IP': '192.0.2.1',
        'X-Vercel-Forwarded-For': '192.0.2.2',
      })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('canonicalizes equivalent IPv6 spellings into one identity', () => {
    expect(
      adapter('node').resolve(
        requestWith({ 'X-Forwarded-For': '2001:0DB8:0:0:0:0:0:1' })
      )
    ).toBe('2001:db8::1');
    expect(
      adapter('node').resolve(requestWith({ 'X-Forwarded-For': '2001:db8::1' }))
    ).toBe('2001:db8::1');
  });

  it('collapses IPv4-mapped IPv6 into the canonical IPv4 identity', () => {
    expect(
      adapter('node').resolve(
        requestWith({ 'X-Forwarded-For': '::ffff:192.0.2.1' })
      )
    ).toBe('192.0.2.1');
    expect(
      adapter('node').resolve(requestWith({ 'X-Forwarded-For': '192.0.2.1' }))
    ).toBe('192.0.2.1');
  });

  it('normalizes supported IP-with-port forms', () => {
    expect(
      adapter('vercel').resolve(
        requestWith({ 'X-Vercel-Forwarded-For': '198.051.100.007:443' })
      )
    ).toBe('198.51.100.7');
    expect(
      adapter('cloudflare').resolve(
        requestWith({ 'CF-Connecting-IP': '[2001:db8::1]:8443' })
      )
    ).toBe('2001:db8::1');
  });

  it('rejects junk and hostnames instead of fragmenting network buckets', () => {
    expect(
      adapter('cloudflare').resolve(
        requestWith({
          'CF-Connecting-IP': 'also.invalid',
          'X-Forwarded-For': 'not-an-ip',
          'X-Real-IP': 'edge.invalid',
        })
      )
    ).toBeUndefined();
  });

  it('returns undefined when no proxy headers are present', () => {
    expect(adapter('node').resolve(requestWith({}))).toBeUndefined();
  });

  it('ignores blank header values and falls through', () => {
    expect(
      adapter('node').resolve(
        requestWith({ 'X-Forwarded-For': '   ', 'X-Real-IP': '192.0.2.1' })
      )
    ).toBeUndefined();
  });

  it('returns undefined when only a blank X-Forwarded-For is present', () => {
    expect(
      adapter('node').resolve(requestWith({ 'X-Forwarded-For': ' , , ' }))
    ).toBeUndefined();
  });

  it('rejects multi-value managed-platform headers instead of choosing one', () => {
    expect(
      adapter('vercel').resolve(
        requestWith({
          'X-Vercel-Forwarded-For': '203.0.113.7, 198.51.100.2',
        })
      )
    ).toBeUndefined();
    expect(
      adapter('cloudflare').resolve(
        requestWith({ 'CF-Connecting-IP': '203.0.113.7, 198.51.100.2' })
      )
    ).toBeUndefined();
  });
});
