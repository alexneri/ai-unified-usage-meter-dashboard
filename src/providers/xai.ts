// xAI cost/balance adapter — official. Architecture §6, Story 2.3.
//
// Uses the SEPARATE management key against the management API host for prepaid
// balance / historical spend:
//   GET https://management-api.x.ai/v1/billing/summary   (Bearer xai-… management key)
//
// The management billing shape is treated as adapter-local and tolerated across
// minor drift; inline `cost_in_usd_ticks` (1 tick = 1e-10 USD) is converted when
// present. Opt-in: registered only when XAI_MANAGEMENT_KEY is present. NOTE:
// consumer Grok (grok.com / X Premium+) has NO official/documented API — it is
// metered separately, best-effort, by the local `grok` reader (the Grok CLI's own
// billing endpoint; confidence:"unofficial") — see src/providers/local/grok.ts.
// This adapter is xAI *platform* billing only. The key never enters the snapshot
// (§4 invariant).

import { ProviderError, errorSnapshot } from '../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../core/types.js';

const BILLING_URL = 'https://management-api.x.ai/v1/billing/summary';
const USD_PER_TICK = 1e-10;

/** Tolerant view of the management billing summary (field names vary by version). */
export interface XaiBilling {
  prepaid_balance_usd?: number;
  credit_balance_usd?: number;
  balance?: number;
  spend_this_month_usd?: number;
  total_spend_usd?: number;
  cost_in_usd_ticks?: number;
}

function firstNumber(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) if (typeof v === 'number' && !Number.isNaN(v)) return v;
  return undefined;
}

/** Pure mapping: management billing summary → balance + spend meters. */
export function mapXaiSnapshot(data: XaiBilling, fetchedAt = new Date().toISOString()): ProviderSnapshot {
  const meters: Meter[] = [];

  const balance = firstNumber(data.prepaid_balance_usd, data.credit_balance_usd, data.balance);
  if (typeof balance === 'number') {
    meters.push({ kind: 'balance', label: 'Balance', value: round(balance), unit: 'usd', remaining: round(balance) });
  }

  let spend = firstNumber(data.spend_this_month_usd, data.total_spend_usd);
  if (spend === undefined && typeof data.cost_in_usd_ticks === 'number') {
    spend = data.cost_in_usd_ticks * USD_PER_TICK;
  }
  if (typeof spend === 'number') {
    meters.push({ kind: 'spend', label: 'Spend', value: round(spend), unit: 'usd' });
  }

  if (meters.length === 0) {
    return errorSnapshot(
      'xai',
      'xAI',
      new ProviderError('xAI billing returned no recognizable balance/spend (unexpected response shape)', {
        retriable: false,
      }),
    );
  }

  return {
    providerId: 'xai',
    displayName: 'xAI',
    meters,
    confidence: 'official',
    freshness: 'live',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export const xai: UsageProvider = {
  id: 'xai',
  displayName: 'xAI',
  confidence: 'official',
  cacheTtlSeconds: 600,
  async fetch(creds: ProviderCredentials): Promise<ProviderSnapshot> {
    const key = creds.XAI_MANAGEMENT_KEY;
    if (!key) {
      return errorSnapshot(
        'xai',
        'xAI',
        new ProviderError('xAI is not configured — set XAI_MANAGEMENT_KEY (management-api.x.ai key)', {
          retriable: false,
        }),
      );
    }
    try {
      let res: Response;
      try {
        res = await fetch(BILLING_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      } catch (e) {
        throw new ProviderError(`network error calling xAI: ${e instanceof Error ? e.message : e}`, { retriable: true });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('xAI auth failed (401/403) — check XAI_MANAGEMENT_KEY (needs a management key)', { retriable: false, status: res.status });
      }
      if (res.status >= 500) throw new ProviderError(`xAI server error (${res.status})`, { retriable: true, status: res.status });
      if (!res.ok) throw new ProviderError(`xAI request failed (${res.status})`, { retriable: false, status: res.status });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError('xAI returned an unexpected (non-JSON) response', { retriable: false });
      }
      return mapXaiSnapshot(body as XaiBilling);
    } catch (e) {
      return errorSnapshot('xai', 'xAI', e);
    }
  },
};
