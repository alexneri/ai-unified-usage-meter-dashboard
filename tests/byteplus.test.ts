import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byteplus, mapByteplusSnapshot, type ByteplusUsageResponse } from '../src/providers/byteplus.js';
import { buildProviders } from '../src/providers/registry.js';

const usage = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/byteplus/usage.json'), 'utf8'),
) as ByteplusUsageResponse;

describe('mapByteplusSnapshot', () => {
  it('maps session/weekly/monthly QuotaUsage to percent quota meters with resets', () => {
    const snap = mapByteplusSnapshot(usage, '2026-07-28T00:00:00.000Z');
    expect(snap.confidence).toBe('official');
    expect(snap.freshness).toBe('live');
    expect(snap.meters.map((m) => m.label)).toEqual(['Session (5h)', 'Weekly (7d)', 'Monthly (30d)']);

    const session = snap.meters.find((m) => m.label === 'Session (5h)');
    expect(session?.kind).toBe('quota');
    expect(session?.unit).toBe('percent');
    expect(session?.value).toBe(16.78); // percent used (rounded 2dp)
    expect(session?.limit).toBe(100);
    expect(session?.remaining).toBe(83.22); // percent left
    expect(session?.resetsAt).toBe(new Date(1785212927 * 1000).toISOString());
  });

  it('returns an error snapshot when no windows are present', () => {
    const snap = mapByteplusSnapshot({ Result: { QuotaUsage: [] } });
    expect(snap.meters).toHaveLength(0);
    expect(snap.error?.retriable).toBe(false);
  });
});

describe('byteplus opt-in registration + key isolation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is NOT registered without a credential, and IS registered with one', () => {
    expect(buildProviders(() => false).map((p) => p.id)).not.toContain('byteplus');
    expect(buildProviders((id) => id === 'byteplus').map((p) => p.id)).toContain('byteplus');
  });

  it('never leaks the AK/SK into the snapshot', async () => {
    const AK = 'AKEXAMPLEmustnotleak';
    const SK = 'SKEXAMPLEmustnotleak00000000';
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => usage }) as Response);
    const snap = await byteplus.fetch(
      { BYTEPLUS_ACCESS_KEY: AK, BYTEPLUS_SECRET_KEY: SK, BYTEPLUS_REGION: 'ap-southeast-1' },
      { periodDays: 30 },
    );
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(AK);
    expect(serialized).not.toContain(SK);
    expect(snap.error).toBeUndefined();
    expect(snap.meters).toHaveLength(3);
  });
});
