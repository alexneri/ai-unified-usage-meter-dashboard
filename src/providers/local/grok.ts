// Local Grok reader — UNOFFICIAL / best-effort. Architecture §6 (local/*), Story 3.x.
//
// Meters consumer Grok CLI billing from the *same* endpoint the Grok CLI itself
// hits, so the Grok bar lives on the same board as everything else:
//
//   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
//   Authorization: Bearer <profile.key>   (from ~/.grok/auth.json)
//   x-grok-client-mode: cli
//
// This is NOT an official/documented API — grok.com itself has no public usage
// surface, and scraping grok.com HTML is a Consumer-ToS violation (NFR7). This
// adapter only calls the CLI billing API using the token the CLI already stored
// locally, and only reads that local auth file. Numbers are the CLI's own credit
// window; the endpoint is undocumented and may change, so the card is
// confidence:"unofficial" (best-effort chip + "may break").
//
// The bearer token is read from ~/.grok/auth.json, used for one request, and
// dropped — it NEVER enters a ProviderSnapshot and is NEVER logged (§4 invariant).
// Official xAI *platform* billing (management-api.x.ai) is a SEPARATE adapter —
// see src/providers/xai.ts.

import { ProviderError, errorSnapshot } from '../../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../../core/types.js';
import { readGrokProfile } from './credentials.js';

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const CLI_VERSION = '0.2.106';

/** A `{ val: number }` wrapper the billing payload uses for money amounts. */
interface GrokVal {
  val?: number;
}

/** The active usage/billing period. */
interface GrokPeriod {
  type?: string; // e.g. USAGE_PERIOD_TYPE_WEEKLY / _MONTHLY
  start?: string; // ISO
  end?: string; // ISO
}

/** Per-product usage row (e.g. { product: "Api", usagePercent: 83 }). */
interface GrokProductUsage {
  product?: string;
  usagePercent?: number;
}

/**
 * Tolerant view of the `config` object inside the billing response. Field names
 * vary across accounts/CLI versions; extra fields observed in the CLI binary
 * (monthlyLimit, includedUsed, totalUsed, billingCycle, subscription_tier,
 * on_demand_enabled, history) are accepted-and-ignored rather than required.
 */
export interface GrokBillingConfig {
  currentPeriod?: GrokPeriod | null;
  creditUsagePercent?: number; // 0–100 USED
  onDemandCap?: GrokVal | number | null;
  onDemandUsed?: GrokVal | number | null;
  productUsage?: GrokProductUsage[] | null;
  isUnifiedBillingUser?: boolean;
  prepaidBalance?: GrokVal | number | null;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  [k: string]: unknown; // tolerate unknown/newer fields
}

/** The billing endpoint response — the meat is under `config` (accept flat too). */
export interface GrokBillingResponse {
  config?: GrokBillingConfig | null;
  [k: string]: unknown;
}

/** Human label for the primary quota, derived from the period type. */
function periodLabel(type?: string): string {
  switch (type) {
    case 'USAGE_PERIOD_TYPE_WEEKLY':
      return 'Weekly window';
    case 'USAGE_PERIOD_TYPE_MONTHLY':
      return 'Monthly window';
    default:
      return 'Billing period';
  }
}

/** Extract a numeric amount from a `{ val }` wrapper or a bare number. */
function valOf(v: GrokVal | number | null | undefined): number | undefined {
  if (typeof v === 'number') return Number.isNaN(v) ? undefined : v;
  if (v && typeof v.val === 'number' && !Number.isNaN(v.val)) return v.val;
  return undefined;
}

/** Seconds between two ISO timestamps, when both parse and end > start. */
function windowSecs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return undefined;
  return Math.round((e - s) / 1000);
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, round(n)));
}

/**
 * Pure mapping: billing `config` → quota + balance meters. No network, no
 * secrets. Exported so unit tests assert fixture → meters without a live call.
 */
export function mapGrokBilling(config: GrokBillingConfig, fetchedAt = new Date().toISOString()): ProviderSnapshot {
  const meters: Meter[] = [];

  // Primary quota: credit usage over the active period (percent USED).
  const period = config.currentPeriod ?? undefined;
  const start = period?.start ?? config.billingPeriodStart;
  const end = period?.end ?? config.billingPeriodEnd;
  const usedPct = typeof config.creditUsagePercent === 'number' ? config.creditUsagePercent : undefined;
  if (typeof usedPct === 'number' && !Number.isNaN(usedPct)) {
    const used = clampPct(usedPct);
    meters.push({
      kind: 'quota',
      label: periodLabel(period?.type),
      value: used, // percent USED
      unit: 'percent',
      limit: 100,
      remaining: round(100 - used), // percent LEFT (drives the bar)
      resetsAt: end,
      windowSeconds: windowSecs(start, end),
    });
  }

  // Optional per-product meters — skip the redundant single row that just mirrors
  // the overall credit percent (don't spam identical bars).
  const products = Array.isArray(config.productUsage) ? config.productUsage : [];
  for (const p of products) {
    if (!p || typeof p.usagePercent !== 'number' || Number.isNaN(p.usagePercent)) continue;
    if (products.length === 1 && typeof usedPct === 'number' && Math.abs(p.usagePercent - usedPct) < 0.01) continue;
    const used = clampPct(p.usagePercent);
    meters.push({
      kind: 'quota',
      label: `${p.product ?? 'Product'} usage`,
      value: used,
      unit: 'percent',
      limit: 100,
      remaining: round(100 - used),
    });
  }

  // Optional balance meters, only when the numbers are meaningful (> 0).
  const prepaid = valOf(config.prepaidBalance);
  if (typeof prepaid === 'number' && prepaid > 0) {
    meters.push({ kind: 'balance', label: 'Prepaid balance', value: round(prepaid), unit: 'usd', remaining: round(prepaid) });
  }
  const cap = valOf(config.onDemandCap);
  if (typeof cap === 'number' && cap > 0) {
    const usedOnDemand = valOf(config.onDemandUsed) ?? 0;
    const remaining = Math.max(0, round(cap - usedOnDemand));
    meters.push({ kind: 'balance', label: 'On-demand remaining', value: remaining, unit: 'usd', limit: round(cap), remaining });
  }

  if (meters.length === 0) {
    return errorSnapshot(
      'grok',
      'Grok',
      new ProviderError('Grok billing response had no recognizable usage (unofficial endpoint changed)', {
        retriable: false,
      }),
      'unofficial',
    );
  }

  return {
    providerId: 'grok',
    displayName: 'Grok',
    meters,
    confidence: 'unofficial',
    freshness: 'live',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Base URL for the CLI billing proxy (overridable for tests). */
function baseUrl(): string {
  return process.env.GROK_BILLING_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Call the Grok CLI billing endpoint with the local bearer token and return the
 * `config` block. Fail-soft up the stack: network/5xx → retriable; auth/parse →
 * non-retriable. The token is used here only and never returned.
 */
async function fetchBilling(key: string): Promise<GrokBillingConfig> {
  const url = `${baseUrl()}/billing?format=credits`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': `grok-cli/${CLI_VERSION}`,
        'x-grok-client-mode': 'cli',
        'x-grok-client-version': CLI_VERSION,
        'x-grok-client-identifier': 'xai-grok-cli',
      },
    });
  } catch (e) {
    throw new ProviderError(`network error reading Grok billing: ${e instanceof Error ? e.message : e}`, {
      retriable: true,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('Grok CLI token was rejected (401/403) — re-login with the Grok CLI', {
      retriable: false,
      status: res.status,
    });
  }
  if (res.status >= 500) {
    throw new ProviderError(`Grok billing server error (${res.status})`, { retriable: true, status: res.status });
  }
  if (!res.ok) {
    throw new ProviderError(`Grok billing request failed (${res.status})`, { retriable: false, status: res.status });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError('Grok billing returned a non-JSON response (unofficial endpoint changed)', {
      retriable: false,
    });
  }
  if (!body || typeof body !== 'object') {
    throw new ProviderError('Grok billing returned an unexpected response shape (unofficial endpoint changed)', {
      retriable: false,
    });
  }
  const resp = body as GrokBillingResponse;
  // The interesting fields live under `config`; tolerate a flat shape too.
  return (resp.config ?? (resp as GrokBillingConfig)) satisfies GrokBillingConfig;
}

export const grok: UsageProvider = {
  id: 'grok',
  displayName: 'Grok',
  confidence: 'unofficial',
  cacheTtlSeconds: 900, // 15 min — a weekly/monthly credit window moves slowly
  async fetch(_creds: ProviderCredentials): Promise<ProviderSnapshot> {
    try {
      // Presence of a local CLI login is the precondition; the token is used for
      // one request only and never placed in the snapshot.
      const profile = readGrokProfile();
      const key = profile?.key;
      if (!key) {
        return errorSnapshot(
          'grok',
          'Grok',
          new ProviderError(
            'No local Grok CLI login found (~/.grok/auth.json) — run the Grok CLI to sign in. (Consumer Grok has no official usage API; this reads the CLI billing endpoint.)',
            { retriable: false },
          ),
          'unofficial',
        );
      }
      const config = await fetchBilling(key);
      return mapGrokBilling(config);
    } catch (e) {
      return errorSnapshot('grok', 'Grok', e, 'unofficial');
    }
  },
};
