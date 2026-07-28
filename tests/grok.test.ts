import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grok, mapGrokBilling, type GrokBillingResponse } from '../src/providers/local/grok.js';

// Mock the local credential reader so CI never touches a real ~/.grok/auth.json.
vi.mock('../src/providers/local/credentials.js', () => ({
  readGrokProfile: vi.fn(() => ({ key: 'grok-LOCAL-token-must-not-leak-abcdef' })),
  machineName: () => 'test-host',
}));
import { readGrokProfile } from '../src/providers/local/credentials.js';

const FIX = resolve(__dirname, '../fixtures/grok');
const credits = JSON.parse(readFileSync(resolve(FIX, 'billing-credits.json'), 'utf8')) as GrokBillingResponse;
const monthly = JSON.parse(readFileSync(resolve(FIX, 'billing-monthly.json'), 'utf8')) as GrokBillingResponse;

describe('mapGrokBilling (fixture → meters, no network)', () => {
  it('maps weekly credit usage into a quota meter (83% used, 17 left, weekly resetsAt)', () => {
    const snap = mapGrokBilling(credits.config!, '2026-07-21T12:00:00.000Z');
    expect(snap.providerId).toBe('grok');
    expect(snap.confidence).toBe('unofficial');
    expect(snap.freshness).toBe('live');

    const weekly = snap.meters.find((m) => m.label === 'Weekly window');
    expect(weekly?.kind).toBe('quota');
    expect(weekly?.value).toBe(83); // percent used
    expect(weekly?.remaining).toBe(17); // percent left
    expect(weekly?.limit).toBe(100);
    expect(weekly?.resetsAt).toBe('2026-07-22T11:52:34.372350+00:00');
    expect(weekly?.windowSeconds).toBe(7 * 86400);

    // A single product row identical to the credit percent is not duplicated,
    // and zero balances/caps produce no balance meters.
    expect(snap.meters).toHaveLength(1);
  });

  it('maps a monthly account with products, prepaid balance and an on-demand cap', () => {
    const snap = mapGrokBilling(monthly.config!, '2026-07-21T12:00:00.000Z');

    const period = snap.meters.find((m) => m.label === 'Monthly window');
    expect(period?.value).toBe(41.5);
    expect(period?.remaining).toBe(58.5);
    expect(period?.resetsAt).toBe('2026-08-01T00:00:00+00:00');
    expect(period?.windowSeconds).toBe(31 * 86400);

    expect(snap.meters.find((m) => m.label === 'Api usage')?.value).toBe(41.5);
    expect(snap.meters.find((m) => m.label === 'Reasoning usage')?.value).toBe(12);

    const prepaid = snap.meters.find((m) => m.label === 'Prepaid balance');
    expect(prepaid?.kind).toBe('balance');
    expect(prepaid?.value).toBe(8.5);

    const onDemand = snap.meters.find((m) => m.label === 'On-demand remaining');
    expect(onDemand?.value).toBe(21); // cap 25 - used 4
    expect(onDemand?.limit).toBe(25);
  });

  it('degrades to a non-retriable "endpoint changed" error when nothing is recognizable', () => {
    const snap = mapGrokBilling({});
    expect(snap.meters).toEqual([]);
    expect(snap.error?.retriable).toBe(false);
    expect(snap.confidence).toBe('unofficial');
  });
});

describe('grok adapter (local-only + fail-soft + no token leak)', () => {
  const ORIG = process.env.GROK_BILLING_BASE_URL;
  beforeEach(() => {
    delete process.env.GROK_BILLING_BASE_URL;
    vi.mocked(readGrokProfile).mockReturnValue({ key: 'grok-LOCAL-token-must-not-leak-abcdef' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG === undefined) delete process.env.GROK_BILLING_BASE_URL;
    else process.env.GROK_BILLING_BASE_URL = ORIG;
  });

  it('calls only the CLI billing endpoint (never scrapes grok.com HTML)', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      calledUrls.push(String(input));
      return { ok: true, status: 200, json: async () => credits } as Response;
    });
    const snap = await grok.fetch({}, { periodDays: 7 });
    expect(snap.error).toBeUndefined();
    expect(snap.meters.length).toBe(1);
    expect(calledUrls).toEqual(['https://cli-chat-proxy.grok.com/v1/billing?format=credits']);
    expect(calledUrls.some((u) => u.includes('grok.com/') && !u.includes('cli-chat-proxy'))).toBe(false);
  });

  it('honors GROK_BILLING_BASE_URL for tests/overrides', async () => {
    process.env.GROK_BILLING_BASE_URL = 'https://example.test/v1';
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      calledUrls.push(String(input));
      return { ok: true, status: 200, json: async () => credits } as Response;
    });
    await grok.fetch({}, { periodDays: 7 });
    expect(calledUrls).toEqual(['https://example.test/v1/billing?format=credits']);
  });

  it('never leaks the local bearer token into the serialized snapshot', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => credits }) as Response);
    const snap = await grok.fetch({}, { periodDays: 7 });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('grok-LOCAL-token');
    expect(serialized).not.toContain('Bearer');
  });

  it('fail-soft (non-retriable) when there is no local Grok CLI login', async () => {
    vi.mocked(readGrokProfile).mockReturnValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const snap = await grok.fetch({}, { periodDays: 7 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snap.error?.retriable).toBe(false);
    expect(snap.meters).toEqual([]);
  });

  it('maps a 401 to a non-retriable error (re-login), never throws', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    const snap = await grok.fetch({}, { periodDays: 7 });
    expect(snap.error?.retriable).toBe(false);
  });

  it('maps a 5xx to a retriable error, never throws', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response);
    const snap = await grok.fetch({}, { periodDays: 7 });
    expect(snap.error?.retriable).toBe(true);
  });
});
