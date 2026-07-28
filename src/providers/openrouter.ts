// OpenRouter adapter — official, live. Architecture §6. Story 1.2.
//
// Endpoints (Bearer sk-or-… from the vault):
//   GET https://openrouter.ai/api/v1/key      → { data: { usage, limit, limit_remaining, is_free_tier, rate_limit } }
//   GET https://openrouter.ai/api/v1/credits   → { data: { total_credits, total_usage } }
//
// EMPIRICAL NOTES (verify against the live API when a key is available):
//   - /api/v1/key is confirmed by research and prior art (openusage, CodexBar):
//       * `usage`           — USD spent on this key (all-time).
//       * `limit`           — USD hard cap on this key, or null when uncapped.
//       * `limit_remaining` — USD remaining under `limit`, or null when uncapped.
//   - /api/v1/credits is the newer credits surface. Field names `total_credits` and
//     `total_usage` are the empirically-observed shape (both USD); account balance
//     remaining = total_credits - total_usage. These are treated as adapter-local
//     and fail-soft: a shape change surfaces as a non-retriable "unexpected response"
//     error card, never a silently-wrong number (Architecture §11 "everything drifts").
//
// The Bearer key is read from creds and NEVER appears in the returned snapshot
// (§4 key-isolation invariant; asserted by tests).

import { ProviderError, errorSnapshot } from '../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../core/types.js';

const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

export interface OpenRouterKeyData {
  usage: number;
  limit: number | null;
  limit_remaining: number | null;
  is_free_tier?: boolean;
  rate_limit?: { requests?: number; interval?: string };
}

export interface OpenRouterCreditsData {
  total_credits: number;
  total_usage: number;
}

/**
 * Pure mapping: (/key, /credits) → normalized meters. No network, no secrets.
 * Exported so unit tests can assert fixture → meters without a live call.
 */
export function mapOpenRouterSnapshot(
  key: OpenRouterKeyData,
  credits: OpenRouterCreditsData | null,
  fetchedAt = new Date().toISOString(),
): ProviderSnapshot {
  const meters: Meter[] = [];

  // Primary spend on this key (all-time USD).
  meters.push({ kind: 'spend', label: 'Spend', value: round(key.usage), unit: 'usd' });

  // Account credit balance (from /credits): remaining = total_credits - total_usage.
  if (credits) {
    const remaining = round(credits.total_credits - credits.total_usage);
    meters.push({
      kind: 'balance',
      label: 'Credits remaining',
      value: remaining,
      unit: 'usd',
      limit: round(credits.total_credits),
      remaining,
    });
  }

  // Per-key spend limit remaining (only when the key is capped).
  if (typeof key.limit === 'number' && typeof key.limit_remaining === 'number') {
    meters.push({
      kind: 'rate_limit',
      label: 'Key limit remaining',
      value: round(key.limit_remaining),
      unit: 'usd',
      limit: round(key.limit),
      remaining: round(key.limit_remaining),
    });
  }

  return {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    meters,
    confidence: 'official',
    freshness: 'live',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function getJson<T>(url: string, apiKey: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (e) {
    // Network-level failure → retriable.
    throw new ProviderError(`network error calling ${redactUrl(url)}: ${e instanceof Error ? e.message : e}`, {
      retriable: true,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(`OpenRouter auth failed (${res.status}) — check the key`, {
      retriable: false,
      status: res.status,
    });
  }
  if (res.status >= 500) {
    throw new ProviderError(`OpenRouter server error (${res.status})`, { retriable: true, status: res.status });
  }
  if (!res.ok) {
    throw new ProviderError(`OpenRouter request failed (${res.status})`, { retriable: false, status: res.status });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError('OpenRouter returned an unexpected (non-JSON) response', { retriable: false });
  }
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ProviderError('OpenRouter returned an unexpected response shape', { retriable: false });
  }
  return (body as { data: T }).data;
}

function redactUrl(url: string): string {
  return url;
}

export const openRouter: UsageProvider = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  confidence: 'official',
  cacheTtlSeconds: 600,
  async fetch(creds: ProviderCredentials): Promise<ProviderSnapshot> {
    const apiKey = creds.OPENROUTER_KEY;
    if (!apiKey) {
      // Not configured → clear, non-retriable "check config" card, never a throw.
      return errorSnapshot(
        'openrouter',
        'OpenRouter',
        new ProviderError('OpenRouter is not configured — set OPENROUTER_KEY in the vault', { retriable: false }),
      );
    }
    try {
      const key = await getJson<OpenRouterKeyData>(KEY_URL, apiKey);
      // /credits is best-effort; if it drifts we still show spend + key limit.
      let credits: OpenRouterCreditsData | null = null;
      try {
        credits = await getJson<OpenRouterCreditsData>(CREDITS_URL, apiKey);
      } catch {
        credits = null;
      }
      return mapOpenRouterSnapshot(key, credits);
    } catch (e) {
      return errorSnapshot('openrouter', 'OpenRouter', e);
    }
  },
};
