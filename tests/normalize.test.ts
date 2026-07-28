import { describe, expect, it } from 'vitest';
import { ProviderError, errorSnapshot, markStale, redact, redactObject, usd } from '../src/core/normalize.js';
import type { ProviderSnapshot } from '../src/core/types.js';

describe('errorSnapshot', () => {
  it('produces a well-formed snapshot with empty meters and error set', () => {
    const s = errorSnapshot('openrouter', 'OpenRouter', new Error('boom'));
    expect(s.providerId).toBe('openrouter');
    expect(s.meters).toEqual([]);
    expect(s.freshness).toBe('stale');
    expect(s.error?.message).toBeTruthy();
    expect(typeof s.error?.retriable).toBe('boolean');
    expect(Date.parse(s.fetchedAt)).not.toBeNaN();
  });

  it('classifies auth/org errors as non-retriable', () => {
    expect(errorSnapshot('x', 'X', new Error('401 Unauthorized')).error?.retriable).toBe(false);
    expect(errorSnapshot('x', 'X', new Error('requires an organization')).error?.retriable).toBe(false);
    expect(errorSnapshot('x', 'X', new Error('not configured')).error?.retriable).toBe(false);
  });

  it('classifies network/5xx/unknown as retriable', () => {
    expect(errorSnapshot('x', 'X', new Error('fetch failed')).error?.retriable).toBe(true);
    expect(errorSnapshot('x', 'X', new Error('503 Service Unavailable')).error?.retriable).toBe(true);
  });

  it('honours ProviderError.retriable', () => {
    expect(errorSnapshot('x', 'X', new ProviderError('nope', { retriable: false })).error?.retriable).toBe(false);
    expect(errorSnapshot('x', 'X', new ProviderError('temp', { retriable: true })).error?.retriable).toBe(true);
  });

  it('redacts key material from the error message', () => {
    const s = errorSnapshot('x', 'X', new Error('bad key sk-or-v1-EXAMPLEabcdef0123456789'));
    expect(s.error?.message).not.toContain('sk-or-v1-EXAMPLE');
    expect(s.error?.message).toContain('[redacted-key]');
  });
});

describe('redact', () => {
  it('scrubs sk- keys and bearer headers', () => {
    expect(redact('Authorization: Bearer sk-or-v1-secretsecretsecret')).not.toContain('secret');
    expect(redact('key=sk-ant-admin01-EXAMPLEabcdefghij')).toContain('[redacted-key]');
    expect(redact('xai-EXAMPLEabcdefghijklmnop')).toContain('[redacted-key]');
  });
});

describe('redactObject', () => {
  it('drops sensitive keys and scrubs strings', () => {
    const out = redactObject({ OPENROUTER_KEY: 'sk-or-v1-xyz', nested: { note: 'Bearer sk-abcdef123456' } }) as Record<
      string,
      unknown
    >;
    expect(out.OPENROUTER_KEY).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toContain('sk-or-v1-xyz');
  });
});

describe('usd + markStale', () => {
  it('formats usd', () => {
    expect(usd(12.5)).toBe('$12.50');
    expect(usd(0.005)).toBe('$0.0050');
  });
  it('markStale flips freshness without mutating', () => {
    const s: ProviderSnapshot = {
      providerId: 'a',
      displayName: 'A',
      meters: [],
      confidence: 'official',
      freshness: 'live',
      fetchedAt: new Date().toISOString(),
    };
    const stale = markStale(s);
    expect(stale.freshness).toBe('stale');
    expect(s.freshness).toBe('live');
  });
});
