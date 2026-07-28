import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepseek, mapDeepSeekSnapshot, type DeepSeekBalance } from '../src/providers/deepseek.js';
import { buildProviders } from '../src/providers/registry.js';
import { mapXaiSnapshot, xai, type XaiBilling } from '../src/providers/xai.js';

const dsBalance = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/deepseek/balance.json'), 'utf8'),
) as DeepSeekBalance;
const xaiBilling = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/xai/billing.json'), 'utf8')) as XaiBilling;

describe('mapDeepSeekSnapshot', () => {
  it('picks the USD row and maps total_balance to a live balance meter', () => {
    const snap = mapDeepSeekSnapshot(dsBalance, '2026-07-21T00:00:00.000Z');
    expect(snap.confidence).toBe('official');
    expect(snap.freshness).toBe('live');
    const bal = snap.meters.find((m) => m.kind === 'balance');
    expect(bal?.value).toBe(8.42);
    expect(bal?.remaining).toBe(8.42);
  });
});

describe('mapXaiSnapshot', () => {
  it('maps prepaid balance + monthly spend', () => {
    const snap = mapXaiSnapshot(xaiBilling, '2026-07-21T00:00:00.000Z');
    expect(snap.meters.find((m) => m.kind === 'balance')?.value).toBe(25);
    expect(snap.meters.find((m) => m.kind === 'spend')?.value).toBe(7.3125);
  });

  it('converts cost_in_usd_ticks (1e-10 USD) when no explicit spend field exists', () => {
    const snap = mapXaiSnapshot({ cost_in_usd_ticks: 73125000000 });
    expect(snap.meters.find((m) => m.kind === 'spend')?.value).toBeCloseTo(7.3125, 4);
  });
});

describe('opt-in registration + key isolation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deepseek/xai are NOT registered when their credential is absent', () => {
    const none = buildProviders(() => false).map((p) => p.id);
    expect(none).not.toContain('deepseek');
    expect(none).not.toContain('xai');
    expect(none).not.toContain('openai');
    expect(none).not.toContain('anthropic');
    // local self-discovering readers are always on
    expect(none).toContain('claude-code');
    expect(none).toContain('codex');
    expect(none).toContain('ccusage');
  });

  it('opt-in adapters register once their credential is present', () => {
    const all = buildProviders((id) => ['deepseek', 'xai', 'openai', 'anthropic'].includes(id)).map((p) => p.id);
    expect(all).toContain('deepseek');
    expect(all).toContain('xai');
  });

  it('deepseek never leaks its Bearer key', async () => {
    const SECRET = 'sk-EXAMPLEdeepseekmustnotleak00000';
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => dsBalance }) as Response);
    const snap = await deepseek.fetch({ DEEPSEEK_KEY: SECRET }, { periodDays: 30 });
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(snap.error).toBeUndefined();
  });

  it('xai never leaks its management key', async () => {
    const SECRET = 'xai-EXAMPLEmanagementmustnotleak00';
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => xaiBilling }) as Response);
    const snap = await xai.fetch({ XAI_MANAGEMENT_KEY: SECRET }, { periodDays: 30 });
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(snap.error).toBeUndefined();
  });
});
