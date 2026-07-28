import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCode, mapClaudeUsage, type ClaudeUsage } from '../src/providers/local/claude-code.js';

// Mock the local credential reader so CI never touches a real keychain.
vi.mock('../src/providers/local/credentials.js', () => ({
  readClaudeOAuth: vi.fn(() => ({ accessToken: 'oauth-LOCAL-TOKEN-must-not-leak-abcdef' })),
  machineName: () => 'test-host',
}));
import { readClaudeOAuth } from '../src/providers/local/credentials.js';

const FIX = resolve(__dirname, '../fixtures/claude-code');
const usageFixture = JSON.parse(readFileSync(resolve(FIX, 'usage.json'), 'utf8')) as ClaudeUsage;
const statusline = JSON.parse(readFileSync(resolve(FIX, 'statusline.json'), 'utf8')) as { rate_limits: ClaudeUsage };

describe('mapClaudeUsage (fixture → quota meters, no network)', () => {
  it('maps five_hour/seven_day utilization into quota meters with resetsAt', () => {
    const snap = mapClaudeUsage(usageFixture, '2026-07-21T12:00:00.000Z');
    expect(snap.providerId).toBe('claude-code');
    expect(snap.confidence).toBe('unofficial');
    expect(snap.freshness).toBe('live');

    const five = snap.meters.find((m) => m.windowSeconds === 5 * 3600);
    expect(five?.kind).toBe('quota');
    expect(five?.value).toBe(2); // percent used
    expect(five?.remaining).toBe(98); // percent left
    expect(five?.limit).toBe(100);
    expect(five?.resetsAt).toBe('2026-07-21T14:00:00.000Z');

    const seven = snap.meters.find((m) => m.windowSeconds === 7 * 86400);
    expect(seven?.value).toBe(31);
    expect(seven?.remaining).toBe(69);
  });

  it('accepts the statusline stdin shape (used_percent variant)', () => {
    const snap = mapClaudeUsage(statusline.rate_limits, '2026-07-21T12:00:00.000Z');
    const five = snap.meters.find((m) => m.windowSeconds === 5 * 3600);
    expect(five?.value).toBe(12.5);
    expect(five?.remaining).toBe(87.5);
  });

  it('degrades to a non-retriable "endpoint changed" error when no windows are present', () => {
    const snap = mapClaudeUsage({});
    expect(snap.meters).toEqual([]);
    expect(snap.error?.retriable).toBe(false);
    expect(snap.confidence).toBe('unofficial');
  });
});

describe('claudeCode adapter (local-only + fail-soft + no token leak)', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_RATE_LIMITS_JSON;
    delete process.env.CLAUDE_CODE_RATE_LIMITS_FILE;
    vi.mocked(readClaudeOAuth).mockReturnValue({ accessToken: 'oauth-LOCAL-TOKEN-must-not-leak-abcdef' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ['CLAUDE_CODE_RATE_LIMITS_JSON', 'CLAUDE_CODE_RATE_LIMITS_FILE']) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  it('prefers the injected statusline snapshot and makes NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.CLAUDE_CODE_RATE_LIMITS_JSON = JSON.stringify(statusline);
    const snap = await claudeCode.fetch({}, { periodDays: 7 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snap.error).toBeUndefined();
    expect(snap.meters.length).toBe(2);
  });

  it('only ever calls the local OAuth usage endpoint (no claude.ai scraping)', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      calledUrls.push(String(input));
      return { ok: true, status: 200, json: async () => usageFixture } as Response;
    });
    await claudeCode.fetch({}, { periodDays: 7 });
    expect(calledUrls).toEqual(['https://api.anthropic.com/api/oauth/usage']);
    expect(calledUrls.some((u) => u.includes('claude.ai'))).toBe(false);
  });

  it('never leaks the local OAuth token into the serialized snapshot', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => usageFixture }) as Response);
    const snap = await claudeCode.fetch({}, { periodDays: 7 });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('oauth-LOCAL-TOKEN');
    expect(serialized).not.toContain('Bearer');
  });

  it('fail-soft (non-retriable) when there is no local login', async () => {
    vi.mocked(readClaudeOAuth).mockReturnValue(null);
    const snap = await claudeCode.fetch({}, { periodDays: 7 });
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
  });

  it('maps a 401 to a non-retriable error (re-login), never throws', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    const snap = await claudeCode.fetch({}, { periodDays: 7 });
    expect(snap.error?.retriable).toBe(false);
  });

  it('maps a 429 to a retriable error (usage-endpoint throttle), never throws', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response);
    const snap = await claudeCode.fetch({}, { periodDays: 7 });
    expect(snap.error?.retriable).toBe(true);
    expect(snap.error?.message.toLowerCase()).toMatch(/429|rate-limited/);
    expect(snap.meters).toEqual([]);
  });
});
