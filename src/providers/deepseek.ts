// DeepSeek balance adapter — official, live. Architecture §6, Story 2.3.
//
//   GET https://api.deepseek.com/user/balance   (Bearer sk-… — same key as inference)
//     → { is_available, balance_infos: [ { currency, total_balance,
//         granted_balance, topped_up_balance } ] }
//
// Opt-in: registered only when DEEPSEEK_KEY is present (no error card for a provider
// the owner doesn't use). Trivial live balance meter. The key never enters the
// snapshot (§4 invariant).

import { ProviderError, errorSnapshot } from '../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../core/types.js';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

export interface DeepSeekBalanceInfo {
  currency?: string;
  total_balance?: string | number;
  granted_balance?: string | number;
  topped_up_balance?: string | number;
}

export interface DeepSeekBalance {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
}

function num(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/** Pure mapping: /user/balance → balance meter. No network, no secrets. */
export function mapDeepSeekSnapshot(data: DeepSeekBalance, fetchedAt = new Date().toISOString()): ProviderSnapshot {
  // Prefer the USD row; else the first row.
  const infos = data.balance_infos ?? [];
  const info = infos.find((i) => (i.currency ?? '').toUpperCase() === 'USD') ?? infos[0];
  const meters: Meter[] = [];
  if (info) {
    const total = round(num(info.total_balance));
    meters.push({ kind: 'balance', label: 'Balance', value: total, unit: 'usd', remaining: total });
  }
  if (meters.length === 0) {
    return errorSnapshot(
      'deepseek',
      'DeepSeek',
      new ProviderError('DeepSeek returned no balance rows (unexpected response shape)', { retriable: false }),
    );
  }
  return {
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    meters,
    confidence: 'official',
    freshness: 'live',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export const deepseek: UsageProvider = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  confidence: 'official',
  cacheTtlSeconds: 600,
  async fetch(creds: ProviderCredentials): Promise<ProviderSnapshot> {
    const key = creds.DEEPSEEK_KEY;
    if (!key) {
      return errorSnapshot(
        'deepseek',
        'DeepSeek',
        new ProviderError('DeepSeek is not configured — set DEEPSEEK_KEY', { retriable: false }),
      );
    }
    try {
      let res: Response;
      try {
        res = await fetch(BALANCE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      } catch (e) {
        throw new ProviderError(`network error calling DeepSeek: ${e instanceof Error ? e.message : e}`, { retriable: true });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('DeepSeek auth failed (401/403) — check DEEPSEEK_KEY', { retriable: false, status: res.status });
      }
      if (res.status >= 500) throw new ProviderError(`DeepSeek server error (${res.status})`, { retriable: true, status: res.status });
      if (!res.ok) throw new ProviderError(`DeepSeek request failed (${res.status})`, { retriable: false, status: res.status });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError('DeepSeek returned an unexpected (non-JSON) response', { retriable: false });
      }
      return mapDeepSeekSnapshot(body as DeepSeekBalance);
    } catch (e) {
      return errorSnapshot('deepseek', 'DeepSeek', e);
    }
  },
};
