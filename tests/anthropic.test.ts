import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anthropic,
  mapAnthropicSnapshot,
  type AnthropicCostBucket,
  type AnthropicRateLimit,
  type AnthropicUsageBucket,
} from '../src/providers/anthropic.js';

const FIX = resolve(__dirname, '../fixtures/anthropic');
const cost = JSON.parse(readFileSync(resolve(FIX, 'cost_report.json'), 'utf8')).data as AnthropicCostBucket[];
const usage = JSON.parse(readFileSync(resolve(FIX, 'usage.json'), 'utf8')).data as AnthropicUsageBucket[];
const rl = JSON.parse(readFileSync(resolve(FIX, 'rate_limits.json'), 'utf8')).data as AnthropicRateLimit[];

describe('mapAnthropicSnapshot (fixture → meters, no network)', () => {
  it('sums string-amount daily costs + tokens; labels RL as static config', () => {
    const snap = mapAnthropicSnapshot(cost, usage, rl, 30, '2026-07-21T00:00:00.000Z');
    expect(snap.confidence).toBe('official');
    expect(snap.freshness).toBe('historical');

    const spend = snap.meters.find((m) => m.kind === 'spend');
    expect(spend?.value).toBe(5.45); // "2.35" + "3.10"

    const tokens = snap.meters.find((m) => m.kind === 'tokens');
    expect(tokens?.value).toBe(1580000); // 900k+120k+300k+260k

    const rlMeter = snap.meters.find((m) => m.kind === 'rate_limit');
    expect(rlMeter?.label.toLowerCase()).toContain('static');
    expect(rlMeter?.remaining).toBeUndefined(); // never a live remaining gauge
    expect(rlMeter?.value).toBe(4000);
  });

  it('omits the static-RL meter when rate_limits is unavailable', () => {
    const snap = mapAnthropicSnapshot(cost, usage, null, 7);
    expect(snap.meters.find((m) => m.kind === 'rate_limit')).toBeUndefined();
  });
});

describe('anthropic adapter (org-only + fail-soft + key isolation)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('non-retriable, no throw, when the Admin key is missing', async () => {
    const snap = await anthropic.fetch({}, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(false);
  });

  it('surfaces a clear "requires an organization" state on 403 (personal account)', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response);
    const snap = await anthropic.fetch({ ANTHROPIC_ADMIN_KEY: 'sk-ant-admin01-personal' }, { periodDays: 30 });
    expect(snap.error?.retriable).toBe(false);
    expect(snap.error?.message.toLowerCase()).toContain('organization');
  });

  it('never leaks the Admin key into the serialized snapshot', async () => {
    const SECRET = 'sk-ant-admin01-EXAMPLEmustnotleak00';
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const data = url.includes('cost_report') ? cost : url.includes('usage_report') ? usage : rl;
      return { ok: true, status: 200, json: async () => ({ data }) } as Response;
    });
    const snap = await anthropic.fetch({ ANTHROPIC_ADMIN_KEY: SECRET }, { periodDays: 30 });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-ant-admin');
    expect(serialized).not.toContain('Bearer');
    expect(snap.error).toBeUndefined();
  });
});
