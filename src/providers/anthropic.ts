// Anthropic org usage + cost report adapter — official, historical, ORG-GATED.
// Architecture §6, §11 (hard truths), Story 2.2.
//
// Endpoints (Admin key `sk-ant-admin01…` or OAuth `org:admin`, always with
// `anthropic-version: 2023-06-01`):
//   GET /v1/organizations/cost_report              → daily USD
//   GET /v1/organizations/usage_report/messages    → token metrics
//   GET /v1/organizations/rate_limits  (optional)  → STATIC configured limits (RPM/ITPM/OTPM)
//
// HARD TRUTHS surfaced honestly:
//   - The Admin API is ORG-ONLY: a personal Claude account can't use it. That case
//     returns a clear "Requires an Anthropic organization" non-retriable state, not
//     a generic failure.
//   - rate_limits are STATIC configured caps, not live consumption — labeled as such,
//     never rendered as a live remaining gauge.
// freshness:"historical" (~5 min lag); TTL 15 min (≤1/min politeness). The key is
// never placed in the snapshot (§4 invariant).

import { ProviderError, errorSnapshot } from '../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../core/types.js';

const BASE = 'https://api.anthropic.com/v1/organizations';
const ANTHROPIC_VERSION = '2023-06-01';

/** A `/cost_report` bucket (amounts may be number or numeric-string). */
export interface AnthropicCostBucket {
  starting_at?: string;
  results: Array<{ amount?: number | string; cost?: number | string; currency?: string }>;
}

/** A `/usage_report/messages` bucket. */
export interface AnthropicUsageBucket {
  results: Array<{
    uncached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  }>;
}

/** A `/rate_limits` entry — STATIC configured limit, not live consumption. */
export interface AnthropicRateLimit {
  model?: string;
  requests_per_minute?: number;
  input_tokens_per_minute?: number;
  output_tokens_per_minute?: number;
}

function num(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function bucketCost(b: AnthropicCostBucket): number {
  return b.results.reduce((s, r) => s + num(r.amount ?? r.cost), 0);
}

/**
 * Pure mapping: (cost, usage, [rate_limits]) → spend + tokens (+ optional static-RL)
 * meters. No network, no secrets. Exported for fixture tests.
 */
export function mapAnthropicSnapshot(
  cost: AnthropicCostBucket[],
  usage: AnthropicUsageBucket[],
  rateLimits: AnthropicRateLimit[] | null,
  periodDays: 7 | 30,
  fetchedAt = new Date().toISOString(),
): ProviderSnapshot {
  const meters: Meter[] = [];

  const totalSpend = round(cost.reduce((s, b) => s + bucketCost(b), 0));
  meters.push({ kind: 'spend', label: `Spend (${periodDays}d)`, value: totalSpend, unit: 'usd', windowSeconds: periodDays * 86400 });

  const totalTokens = usage.reduce(
    (s, b) =>
      s +
      b.results.reduce(
        (rs, r) =>
          rs +
          (r.uncached_input_tokens ?? 0) +
          (r.cache_creation_input_tokens ?? 0) +
          (r.cache_read_input_tokens ?? 0) +
          (r.output_tokens ?? 0),
        0,
      ),
    0,
  );
  if (usage.length > 0) {
    meters.push({ kind: 'tokens', label: `Tokens (${periodDays}d)`, value: Math.round(totalTokens), unit: 'tokens', windowSeconds: periodDays * 86400 });
  }

  // Optional STATIC configured RPM — labeled so it can't be mistaken for live pool.
  if (rateLimits && rateLimits.length > 0) {
    const rpm = rateLimits.reduce((max, r) => Math.max(max, r.requests_per_minute ?? 0), 0);
    if (rpm > 0) {
      meters.push({ kind: 'rate_limit', label: 'Configured RPM (static)', value: rpm, unit: 'requests' });
    }
  }

  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    meters,
    confidence: 'official',
    freshness: 'historical',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function getData<T>(path: string, key: string, params: Record<string, string>, optional = false): Promise<T[]> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'anthropic-version': ANTHROPIC_VERSION },
    });
  } catch (e) {
    throw new ProviderError(`network error calling Anthropic: ${e instanceof Error ? e.message : e}`, { retriable: true });
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    // Personal (non-org) accounts can't reach the Admin API — surface that plainly.
    throw new ProviderError(
      'Anthropic Admin API unavailable — requires an Anthropic organization (personal accounts cannot use it), or the Admin key is invalid',
      { retriable: false, status: res.status },
    );
  }
  if (res.status >= 500) throw new ProviderError(`Anthropic server error (${res.status})`, { retriable: true, status: res.status });
  if (!res.ok) {
    if (optional) return [];
    throw new ProviderError(`Anthropic request failed (${res.status})`, { retriable: false, status: res.status });
  }
  let body: { data?: T[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ProviderError('Anthropic returned an unexpected (non-JSON) response', { retriable: false });
  }
  if (!Array.isArray(body.data)) {
    if (optional) return [];
    throw new ProviderError('Anthropic returned an unexpected response shape', { retriable: false });
  }
  return body.data;
}

export const anthropic: UsageProvider = {
  id: 'anthropic',
  displayName: 'Anthropic',
  confidence: 'official',
  cacheTtlSeconds: 900, // 15 min — ≤1/min politeness, ~5 min freshness
  async fetch(creds: ProviderCredentials, opts: { periodDays: 7 | 30 }): Promise<ProviderSnapshot> {
    const key = creds.ANTHROPIC_ADMIN_KEY;
    if (!key) {
      return errorSnapshot(
        'anthropic',
        'Anthropic',
        new ProviderError('Anthropic is not configured — set an org Admin key (ANTHROPIC_ADMIN_KEY, sk-ant-admin01…)', {
          retriable: false,
        }),
      );
    }
    const startIso = new Date(Date.now() - opts.periodDays * 86400 * 1000).toISOString();
    try {
      const cost = await getData<AnthropicCostBucket>('cost_report', key, { starting_at: startIso });
      let usage: AnthropicUsageBucket[] = [];
      try {
        usage = await getData<AnthropicUsageBucket>('usage_report/messages', key, { starting_at: startIso }, true);
      } catch {
        usage = [];
      }
      // rate_limits is optional and only static config; never block the card on it.
      let rateLimits: AnthropicRateLimit[] | null = null;
      try {
        rateLimits = await getData<AnthropicRateLimit>('rate_limits', key, {}, true);
      } catch {
        rateLimits = null;
      }
      return mapAnthropicSnapshot(cost, usage, rateLimits, opts.periodDays);
    } catch (e) {
      return errorSnapshot('anthropic', 'Anthropic', e);
    }
  },
};
