import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ccusage, extractJson, mapCcusage, type CcusageJson } from '../src/providers/local/ccusage.js';

const FIX = resolve(__dirname, '../fixtures/ccusage');
const daily = JSON.parse(readFileSync(resolve(FIX, 'daily.json'), 'utf8')) as CcusageJson;

describe('mapCcusage (fixture → estimate meters)', () => {
  it('maps totals into a tokens + spend estimate, labeled as an estimate', () => {
    const snap = mapCcusage(daily, '2026-07-21T12:00:00.000Z');
    expect(snap.providerId).toBe('ccusage');
    expect(snap.confidence).toBe('unofficial');
    expect(snap.freshness).toBe('historical');
    expect(snap.displayName.toLowerCase()).toContain('estimate');

    const tokens = snap.meters.find((m) => m.kind === 'tokens');
    expect(tokens?.value).toBe(2230000);
    expect(tokens?.label.toLowerCase()).toContain('est');

    const spend = snap.meters.find((m) => m.kind === 'spend');
    expect(spend?.value).toBe(5.65);
    expect(spend?.label.toLowerCase()).toContain('est');
  });

  it('falls back to summing the daily array when totals are absent', () => {
    const snap = mapCcusage({ daily: daily.daily });
    expect(snap.meters.find((m) => m.kind === 'tokens')?.value).toBe(2230000);
    expect(snap.meters.find((m) => m.kind === 'spend')?.value).toBeCloseTo(5.65, 2);
  });

  it('degrades to a non-retriable error when the shape has no totals/daily', () => {
    const snap = mapCcusage({});
    expect(snap.error?.retriable).toBe(false);
  });
});

describe('extractJson', () => {
  it('pulls the JSON object out of stdout that has a leading banner', () => {
    const out = 'ccusage v1.0\nLoading...\n{"totals":{"totalTokens":10,"totalCost":0.1}}\n';
    expect(extractJson(out)?.totals?.totalTokens).toBe(10);
  });
});

describe('ccusage adapter (fail-soft on absence)', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    for (const k of ['CCUSAGE_JSON', 'CCUSAGE_CMD']) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  it('uses the CCUSAGE_JSON injection without spawning a subprocess', async () => {
    process.env.CCUSAGE_JSON = JSON.stringify(daily);
    const snap = await ccusage.fetch({}, { periodDays: 7 });
    expect(snap.error).toBeUndefined();
    expect(snap.meters.find((m) => m.kind === 'tokens')?.value).toBe(2230000);
  });

  it('fail-soft (error card, never throws) when the subprocess is unavailable', async () => {
    delete process.env.CCUSAGE_JSON;
    process.env.CCUSAGE_CMD = '/nonexistent/ccusage-not-installed';
    const snap = await ccusage.fetch({}, { periodDays: 7 });
    expect(snap.error).toBeDefined();
    expect(snap.meters).toEqual([]);
  });
});
