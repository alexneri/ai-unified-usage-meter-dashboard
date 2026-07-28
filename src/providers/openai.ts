// OpenAI org usage + costs adapter — official, historical. Architecture §6, Story 2.1.
//
// Endpoints (Admin key `sk-admin…` — a normal project key is rejected on /organization/*):
//   GET /v1/organization/costs?start_time=…&bucket_width=1d   → daily USD buckets
//   GET /v1/organization/usage/completions?start_time=…       → token/request counts
//
// Produces a spend meter (daily USD, invoice-accurate) + a tokens meter + a daily
// spend sparkline. freshness:"historical" — costs lag hours. There is deliberately
// NO live rate-limit gauge: org usage cannot be polled passively as remaining pool,
// and the card must not imply one (Story 2.1 AC). The Admin key is read from creds,
// used for the request, and NEVER placed in the snapshot (§4 invariant).

import { ProviderError, errorSnapshot } from '../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, Series, UsageProvider } from '../core/types.js';

const BASE = 'https://api.openai.com/v1/organization';

/** A `/organization/costs` bucket. */
export interface OpenAICostBucket {
  start_time: number;
  end_time: number;
  results: Array<{ amount?: { value?: number; currency?: string } }>;
}

/** A `/organization/usage/completions` bucket. */
export interface OpenAIUsageBucket {
  start_time: number;
  end_time: number;
  results: Array<{ input_tokens?: number; output_tokens?: number; num_model_requests?: number }>;
}

function bucketCost(b: OpenAICostBucket): number {
  return b.results.reduce((s, r) => s + (r.amount?.value ?? 0), 0);
}

/**
 * Pure mapping: (costs, usage) buckets → spend + tokens meters + daily-spend
 * sparkline. No network, no secrets. Exported for fixture tests.
 */
export function mapOpenAISnapshot(
  costs: OpenAICostBucket[],
  usage: OpenAIUsageBucket[],
  periodDays: 7 | 30,
  fetchedAt = new Date().toISOString(),
): ProviderSnapshot {
  const meters: Meter[] = [];

  const totalSpend = round(costs.reduce((s, b) => s + bucketCost(b), 0));
  meters.push({ kind: 'spend', label: `Spend (${periodDays}d)`, value: totalSpend, unit: 'usd', windowSeconds: periodDays * 86400 });

  const totalTokens = usage.reduce(
    (s, b) => s + b.results.reduce((rs, r) => rs + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0),
    0,
  );
  if (usage.length > 0) {
    meters.push({ kind: 'tokens', label: `Tokens (${periodDays}d)`, value: Math.round(totalTokens), unit: 'tokens', windowSeconds: periodDays * 86400 });
  }

  let sparkline: Series | undefined;
  if (costs.length > 1) {
    sparkline = {
      unit: 'usd',
      points: costs.map((b) => ({ t: new Date(b.start_time * 1000).toISOString(), v: round(bucketCost(b)) })),
    };
  }

  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    meters,
    sparkline,
    confidence: 'official',
    freshness: 'historical', // costs lag hours
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Fetch every page of an org list endpoint (cursor pagination), returning `data`. */
async function getBuckets<T>(path: string, key: string, startTime: number): Promise<T[]> {
  const out: T[] = [];
  let page: string | undefined;
  for (let i = 0; i < 40; i++) {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('start_time', String(startTime));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    if (page) url.searchParams.set('page', page);

    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    } catch (e) {
      throw new ProviderError(`network error calling OpenAI: ${e instanceof Error ? e.message : e}`, { retriable: true });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('OpenAI rejected the key — /organization/* needs an Admin key (sk-admin…)', {
        retriable: false,
        status: res.status,
      });
    }
    if (res.status >= 500) throw new ProviderError(`OpenAI server error (${res.status})`, { retriable: true, status: res.status });
    if (!res.ok) throw new ProviderError(`OpenAI request failed (${res.status})`, { retriable: false, status: res.status });

    let body: { data?: T[]; has_more?: boolean; next_page?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ProviderError('OpenAI returned an unexpected (non-JSON) response', { retriable: false });
    }
    if (!Array.isArray(body.data)) throw new ProviderError('OpenAI returned an unexpected response shape', { retriable: false });
    out.push(...body.data);
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return out;
}

export const openAI: UsageProvider = {
  id: 'openai',
  displayName: 'OpenAI',
  confidence: 'official',
  cacheTtlSeconds: 900, // historical — 15 min is plenty
  async fetch(creds: ProviderCredentials, opts: { periodDays: 7 | 30 }): Promise<ProviderSnapshot> {
    const key = creds.OPENAI_ADMIN_KEY;
    if (!key) {
      return errorSnapshot(
        'openai',
        'OpenAI',
        new ProviderError('OpenAI is not configured — set an Admin key (OPENAI_ADMIN_KEY, sk-admin…) in the vault', {
          retriable: false,
        }),
      );
    }
    const startTime = Math.floor(Date.now() / 1000) - opts.periodDays * 86400;
    try {
      const costs = await getBuckets<OpenAICostBucket>('costs', key, startTime);
      // Usage is best-effort — if it drifts we still show spend.
      let usage: OpenAIUsageBucket[] = [];
      try {
        usage = await getBuckets<OpenAIUsageBucket>('usage/completions', key, startTime);
      } catch {
        usage = [];
      }
      return mapOpenAISnapshot(costs, usage, opts.periodDays);
    } catch (e) {
      return errorSnapshot('openai', 'OpenAI', e);
    }
  },
};
