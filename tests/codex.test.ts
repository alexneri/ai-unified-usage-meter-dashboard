import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codex,
  mapCodexRateLimits,
  parseRpcRateLimits,
  type CodexRateLimits,
} from '../src/providers/local/codex.js';

vi.mock('../src/providers/local/credentials.js', () => ({
  readCodexAuth: vi.fn(() => ({ tokens: { access_token: 'codex-LOCAL-token-must-not-leak' } })),
}));
import { readCodexAuth } from '../src/providers/local/credentials.js';

const FIX = resolve(__dirname, '../fixtures/codex');
const rl = JSON.parse(readFileSync(resolve(FIX, 'rate-limits.json'), 'utf8')) as CodexRateLimits;
const appServerOut = readFileSync(resolve(FIX, 'app-server-output.txt'), 'utf8');

describe('mapCodexRateLimits (fixture → meters, no subprocess)', () => {
  it('maps primary/secondary windows to quota meters and credits to a balance', () => {
    const snap = mapCodexRateLimits(rl, '2026-07-21T12:00:00.000Z');
    expect(snap.providerId).toBe('codex');
    expect(snap.confidence).toBe('unofficial');

    const primary = snap.meters.find((m) => m.label === '5-hour window');
    expect(primary?.value).toBe(8);
    expect(primary?.remaining).toBe(92);
    // resets_in_seconds (9000) → resetsAt = fetchedAt + 2.5h
    expect(primary?.resetsAt).toBe('2026-07-21T14:30:00.000Z');
    expect(primary?.windowSeconds).toBe(300 * 60);

    const secondary = snap.meters.find((m) => m.label === 'Weekly window');
    expect(secondary?.value).toBe(52);
    expect(secondary?.resetsAt).toBe('2026-07-26T00:00:00.000Z');

    const credits = snap.meters.find((m) => m.kind === 'balance');
    expect(credits?.value).toBe(4.75);
  });

  it('accepts the nested rate_limits.{primary,secondary} shape', () => {
    const snap = mapCodexRateLimits({ rate_limits: { primary: { used_percent: 10 } } });
    expect(snap.meters.find((m) => m.label === '5-hour window')?.value).toBe(10);
  });

  it('degrades to "unofficial endpoint changed" when no windows recognized', () => {
    const snap = mapCodexRateLimits({});
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
  });
});

describe('parseRpcRateLimits (JSON-RPC newline-delimited output)', () => {
  it('extracts the rate-limits result from mixed app-server stdout', () => {
    const parsed = parseRpcRateLimits(appServerOut);
    expect(parsed?.primary_window?.used_percent).toBe(8);
    expect(parsed?.secondary_window?.used_percent).toBe(52);
  });
  it('returns null when no result frame is present', () => {
    expect(parseRpcRateLimits('garbage\n{"jsonrpc":"2.0","method":"log"}')).toBeNull();
  });
});

describe('codex adapter (fail-soft on broken/missing binary)', () => {
  afterEach(() => {
    delete process.env.CODEX_BIN;
    vi.mocked(readCodexAuth).mockReturnValue({ tokens: { access_token: 'codex-LOCAL-token-must-not-leak' } });
  });

  it('returns a non-retriable error (no throw) when the CLI binary is missing (this Mac)', async () => {
    process.env.CODEX_BIN = '/nonexistent/codex-broken-binary';
    const snap = await codex.fetch({}, { periodDays: 7 });
    expect(snap.error).toBeDefined();
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
    // token must not appear anywhere in the snapshot
    expect(JSON.stringify(snap)).not.toContain('codex-LOCAL-token');
  });

  it('fail-soft (non-retriable) when there is no local Codex login', async () => {
    vi.mocked(readCodexAuth).mockReturnValue(null);
    const snap = await codex.fetch({}, { periodDays: 7 });
    expect(snap.error?.retriable).toBe(false);
  });
});
