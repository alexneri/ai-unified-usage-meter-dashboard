import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileCache, MemoryCache } from '../src/core/cache.js';
import { PollingScheduler } from '../src/core/scheduler.js';
import { makeFakeProvider } from '../src/providers/fake.js';
import type { ProviderSnapshot } from '../src/core/types.js';

function snap(id: string): ProviderSnapshot {
  return {
    providerId: id,
    displayName: id,
    meters: [{ kind: 'spend', label: 'Spend', value: 1, unit: 'usd' }],
    confidence: 'official',
    freshness: 'live',
    fetchedAt: new Date().toISOString(),
  };
}

describe('CacheStore implementations', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'aud-cache-'));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('MemoryCache round-trips', async () => {
    const c = new MemoryCache();
    expect(await c.get('x')).toBeNull();
    await c.set('x', snap('x'), 300);
    expect((await c.get('x'))?.providerId).toBe('x');
  });

  it('JsonFileCache persists across instances (survives restart)', async () => {
    const path = resolve(tmp, 'cache.json');
    const a = new JsonFileCache(path);
    await a.set('openrouter', snap('openrouter'), 600);
    const b = new JsonFileCache(path); // fresh instance = simulated restart
    expect((await b.get('openrouter'))?.providerId).toBe('openrouter');
  });
});

describe('PollingScheduler', () => {
  function build(now: { t: number }) {
    return new PollingScheduler({
      cache: new MemoryCache(),
      resolveCredentials: () => ({}),
      now: () => now.t,
      staggerMs: 0,
    });
  }

  it('snapshotAll includes a never-fetched provider as an empty placeholder (not omitted)', async () => {
    const now = { t: 1_000_000 };
    const s = build(now);
    s.register(makeFakeProvider({ id: 'openrouter', displayName: 'OpenRouter' }));
    const before = await s.snapshotAll();
    expect(before).toHaveLength(1);
    expect(before[0]!.providerId).toBe('openrouter');
    expect(before[0]!.meters).toEqual([]);
    expect(before[0]!.error).toBeUndefined();
  });

  it('fail-soft: one adapter errors, array stays complete and others still poll', async () => {
    const now = { t: 1_000_000 };
    const s = build(now);
    s.register(makeFakeProvider({ id: 'good' }));
    s.register(makeFakeProvider({ id: 'bad', failWith: new Error('401 unauthorized') }));
    s.register(makeFakeProvider({ id: 'boom', throwInstead: true })); // misbehaving adapter
    await s.tick();
    const all = await s.snapshotAll();
    expect(all.map((x) => x.providerId).sort()).toEqual(['bad', 'boom', 'good']);
    expect(all.find((x) => x.providerId === 'good')?.meters.length).toBeGreaterThan(0);
    expect(all.find((x) => x.providerId === 'bad')?.error?.retriable).toBe(false);
    // The throwing adapter did not crash the loop; health reports it as not-ok.
    const health = s.health();
    expect(health.find((h) => h.id === 'good')?.ok).toBe(true);
    expect(health.find((h) => h.id === 'boom')?.ok).toBe(false);
  });

  it('marks entries stale once past their TTL (read-through)', async () => {
    const now = { t: 1_000_000 };
    const s = build(now);
    s.register(makeFakeProvider({ id: 'openrouter' })); // cacheTtlSeconds = 300
    await s.tick();
    expect((await s.snapshotAll())[0]!.freshness).toBe('live');
    now.t += 301 * 1000; // advance past TTL
    const stale = await s.snapshotAll();
    expect(stale[0]!.freshness).toBe('stale');
  });

  it('serialized snapshot contains no key prefixes or auth header names (NFR1)', async () => {
    const now = { t: 1_000_000 };
    const s = build(now);
    s.register(makeFakeProvider({ id: 'openrouter' }));
    await s.tick();
    const body = JSON.stringify(await s.snapshotAll());
    for (const needle of ['sk-', 'sk-or-', 'sk-admin', 'sk-ant-', 'authorization', 'bearer']) {
      expect(body.toLowerCase()).not.toContain(needle);
    }
  });

  it('keeps last-good meters when a later poll returns a retriable error (429-style)', async () => {
    const now = { t: 1_000_000 };
    const cache = new MemoryCache();
    const s = new PollingScheduler({
      cache,
      resolveCredentials: () => ({}),
      now: () => now.t,
      staggerMs: 0,
    });
    // First poll succeeds with meters.
    const provider = makeFakeProvider({ id: 'claude-code', displayName: 'Claude Code' });
    s.register(provider);
    await s.tick();
    const good = (await s.snapshotAll()).find((x) => x.providerId === 'claude-code');
    expect(good?.error).toBeUndefined();
    expect(good?.meters.length).toBeGreaterThan(0);

    // Later poll returns a retriable empty-error snapshot (adapter 429 path).
    now.t += 301 * 1000;
    provider.fetch = async () => ({
      providerId: 'claude-code',
      displayName: 'Claude Code',
      meters: [],
      confidence: 'unofficial',
      freshness: 'stale',
      fetchedAt: new Date(now.t).toISOString(),
      error: { message: 'rate-limited (429)', retriable: true },
    });
    await s.tick();
    const kept = await cache.get('claude-code');
    expect(kept?.error).toBeUndefined();
    expect(kept?.meters.length).toBeGreaterThan(0);
    // Health reflects the failed poll, even though last-good meters remain.
    expect(s.health().find((h) => h.id === 'claude-code')?.ok).toBe(false);
  });
});
