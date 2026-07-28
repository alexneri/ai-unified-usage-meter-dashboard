import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mapOpenAISnapshot,
  openAI,
  type OpenAICostBucket,
  type OpenAIUsageBucket,
} from '../src/providers/openai.js';

const FIX = resolve(__dirname, '../fixtures/openai');
const costs = JSON.parse(readFileSync(resolve(FIX, 'costs.json'), 'utf8')).data as OpenAICostBucket[];
const usage = JSON.parse(readFileSync(resolve(FIX, 'usage.json'), 'utf8')).data as OpenAIUsageBucket[];

describe('mapOpenAISnapshot (fixture → meters + sparkline, no network)', () => {
  it('sums daily costs + tokens; historical; no live-RL gauge', () => {
    const snap = mapOpenAISnapshot(costs, usage, 30, '2026-07-21T00:00:00.000Z');
    expect(snap.providerId).toBe('openai');
    expect(snap.confidence).toBe('official');
    expect(snap.freshness).toBe('historical');

    const spend = snap.meters.find((m) => m.kind === 'spend');
    expect(spend?.value).toBe(3.5); // 1.42 + 2.08

    const tokens = snap.meters.find((m) => m.kind === 'tokens');
    expect(tokens?.value).toBe(1850000); // (820k+240k)+(610k+180k)

    // No live rate-limit meter is ever produced (Story 2.1 AC).
    expect(snap.meters.find((m) => m.kind === 'rate_limit')).toBeUndefined();

    expect(snap.sparkline?.unit).toBe('usd');
    expect(snap.sparkline?.points.length).toBe(2);
  });
});

describe('openAI adapter (fail-soft + key isolation)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('non-retriable, no throw, when the Admin key is missing', async () => {
    const snap = await openAI.fetch({}, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
  });

  it('never leaks the Admin key into the serialized snapshot', async () => {
    const SECRET = 'sk-admin-EXAMPLEmustnotleak000000';
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const data = url.includes('usage/completions') ? usage : costs;
      return { ok: true, status: 200, json: async () => ({ data, has_more: false }) } as Response;
    });
    const snap = await openAI.fetch({ OPENAI_ADMIN_KEY: SECRET }, { periodDays: 30 });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-admin');
    expect(serialized).not.toContain('Bearer');
    expect(snap.error).toBeUndefined();
  });

  it('maps 401 (project key on org endpoint) to a non-retriable error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    const snap = await openAI.fetch({ OPENAI_ADMIN_KEY: 'sk-proj-notadmin' }, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(false);
  });
});
