// Usage-history contracts — the "cost & usage over time" view (ccusage daily).
// DELIBERATELY separate from the binding ProviderSnapshot in types.ts: a snapshot
// is a point-in-time meter for a card; this is a time series + per-model breakdown
// for a whole screen. Keeping them apart preserves the §4 snapshot invariant.
//
// IMPORTANT HONESTY NOTE: every `cost` here is ccusage's ESTIMATE of what the
// reconstructed token usage WOULD cost at published API list prices — a
// counterfactual, NOT a bill and NOT what a subscription actually charged. The UI
// must label it as such. Rows a source has no public price for surface cost: 0.

/** One model's aggregated stats over a day or the whole window. */
export interface UsageModelStat {
  model: string;
  cost: number; // USD estimate at list prices
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

/** One calendar day of usage across all detected agents. */
export interface UsageDay {
  date: string; // YYYY-MM-DD
  agents: string[]; // e.g. ['claude','codex','openclaw']
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  models: UsageModelStat[];
}

/** Window-wide aggregates plus the honest, JSON-only cache derivations. */
export interface UsageTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** input + output + cacheCreation + cacheRead — all token work done. */
  processedTokens: number;
  /** input + cacheCreation — tokens billed as "fresh" (not cheap cache reads). */
  freshInputTokens: number;
  /** cacheRead / processed, 0..1 — how much of the work came from cache. */
  cacheReadShare: number;
  /** cacheRead / max(freshInput,1) — each fresh input token was reused N×.
   *  This is a TOKEN-reuse leverage ratio, not a dollar multiplier (deriving a
   *  dollar counterfactual needs per-model input vs cache-read prices, which the
   *  daily JSON does not carry — that lands in a later pass). */
  cacheLeverage: number;
  days: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** The whole payload served by /api/usage and rendered by the history page. */
export interface UsageHistory {
  source: 'ccusage';
  confidence: 'unofficial'; // reconstructed from local logs, may drift
  generatedAt: string; // ISO — when this was computed
  days: UsageDay[]; // ascending by date
  totals: UsageTotals;
  models: UsageModelStat[]; // aggregated over the window, desc by cost then tokens
  error?: { message: string; retriable: boolean }; // fail-soft: render an honest empty state
}

export function zeroTotals(): UsageTotals {
  return {
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    processedTokens: 0,
    freshInputTokens: 0,
    cacheReadShare: 0,
    cacheLeverage: 0,
    days: 0,
    firstDate: null,
    lastDate: null,
  };
}

/** Empty, non-error placeholder — the "never computed yet" state. */
export function emptyHistory(generatedAt = new Date(0).toISOString()): UsageHistory {
  return { source: 'ccusage', confidence: 'unofficial', generatedAt, days: [], totals: zeroTotals(), models: [] };
}

/** Running cumulative sum of a series — the last element equals the grand total.
 *  Monotonic non-decreasing for non-negative inputs (cost/tokens are). */
export function toCumulative(nums: number[]): number[] {
  let run = 0;
  return nums.map((n) => (run += n));
}
