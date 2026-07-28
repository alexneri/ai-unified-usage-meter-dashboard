import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mapOpenRouterSnapshot,
  openRouter,
  type OpenRouterCreditsData,
  type OpenRouterKeyData,
} from '../src/providers/openrouter.js';

const FIX = resolve(__dirname, '../fixtures/openrouter');
const keyFixture = JSON.parse(readFileSync(resolve(FIX, 'key.json'), 'utf8')).data as OpenRouterKeyData;
const creditsFixture = JSON.parse(readFileSync(resolve(FIX, 'credits.json'), 'utf8')).data as OpenRouterCreditsData;

describe('mapOpenRouterSnapshot (fixture → meters, no network)', () => {
  it('maps /key + /credits into spend, balance, and key-limit meters', () => {
    const snap = mapOpenRouterSnapshot(keyFixture, creditsFixture, '2026-07-20T00:00:00.000Z');
    expect(snap.providerId).toBe('openrouter');
    expect(snap.confidence).toBe('official');
    expect(snap.freshness).toBe('live');

    const spend = snap.meters.find((m) => m.kind === 'spend');
    expect(spend?.value).toBe(12.5);
    expect(spend?.unit).toBe('usd');

    const balance = snap.meters.find((m) => m.kind === 'balance');
    expect(balance?.value).toBe(37.5); // 50 total - 12.5 used
    expect(balance?.limit).toBe(50);
    expect(balance?.remaining).toBe(37.5);

    const rl = snap.meters.find((m) => m.kind === 'rate_limit');
    expect(rl?.remaining).toBe(7.5);
    expect(rl?.limit).toBe(20);
  });

  it('omits the balance meter when /credits is unavailable, keeps spend + limit', () => {
    const snap = mapOpenRouterSnapshot(keyFixture, null);
    expect(snap.meters.find((m) => m.kind === 'balance')).toBeUndefined();
    expect(snap.meters.find((m) => m.kind === 'spend')).toBeDefined();
    expect(snap.meters.find((m) => m.kind === 'rate_limit')).toBeDefined();
  });

  it('omits the key-limit meter for an uncapped key', () => {
    const uncapped: OpenRouterKeyData = { usage: 3, limit: null, limit_remaining: null };
    const snap = mapOpenRouterSnapshot(uncapped, creditsFixture);
    expect(snap.meters.find((m) => m.kind === 'rate_limit')).toBeUndefined();
  });
});

describe('openRouter adapter (fail-soft + key isolation)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(handler: (url: string) => { status?: number; json?: unknown }) {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const { status = 200, json = {} } = handler(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
      } as Response;
    });
  }

  it('never leaks the Bearer key into the serialized snapshot', async () => {
    const SECRET = 'sk-or-v1-EXAMPLEmustnotleak000000';
    stubFetch((url) =>
      url.includes('/credits') ? { json: { data: creditsFixture } } : { json: { data: keyFixture } },
    );
    const snap = await openRouter.fetch({ OPENROUTER_KEY: SECRET }, { periodDays: 30 });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-or-');
    expect(serialized).not.toContain('Bearer');
    expect(snap.error).toBeUndefined();
  });

  it('returns a non-retriable error (no throw) when not configured', async () => {
    const snap = await openRouter.fetch({}, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
  });

  it('maps 401 to a non-retriable error snapshot', async () => {
    stubFetch(() => ({ status: 401 }));
    const snap = await openRouter.fetch({ OPENROUTER_KEY: 'sk-or-v1-bad' }, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(false);
  });

  it('maps 5xx to a retriable error snapshot', async () => {
    stubFetch(() => ({ status: 503 }));
    const snap = await openRouter.fetch({ OPENROUTER_KEY: 'sk-or-v1-key' }, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(true);
  });
});
