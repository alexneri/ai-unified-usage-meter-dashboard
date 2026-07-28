import { describe, expect, it } from 'vitest';
import { makeFakeProvider } from '../src/providers/fake.js';
import type { UsageProvider } from '../src/core/types.js';

// Story 1.1: the core treats ANY UsageProvider identically; an adapter that
// "returns error instead of throwing" surfaces as snapshot.error (fail-soft).

describe('UsageProvider contract via fake adapter', () => {
  it('a healthy fake returns meters and never an error', async () => {
    const p: UsageProvider = makeFakeProvider();
    const snap = await p.fetch({}, { periodDays: 30 });
    expect(snap.error).toBeUndefined();
    expect(snap.meters.length).toBeGreaterThan(0);
    expect(snap.freshness).toBe('live');
  });

  it('fail-soft: a failing adapter returns an error snapshot, does NOT throw', async () => {
    const p = makeFakeProvider({ failWith: new Error('401 unauthorized') });
    const snap = await p.fetch({}, { periodDays: 30 });
    expect(snap.error).toBeDefined();
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
  });

  it('exposes the exact contract fields', () => {
    const p = makeFakeProvider();
    expect(typeof p.id).toBe('string');
    expect(typeof p.displayName).toBe('string');
    expect(['official', 'unofficial']).toContain(p.confidence);
    expect(p.cacheTtlSeconds).toBeGreaterThan(0);
    expect(typeof p.fetch).toBe('function');
  });
});
