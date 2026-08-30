// Aggregation helpers shared by the ccusage mapper and the durable ledger.
// Kept in core (not in the provider) because the ledger sums across machines and
// must reuse the exact same day/model/total math the single-machine mapper uses.

import type { UsageDay, UsageModelStat, UsageTotals } from './history-types.js';
import { zeroTotals } from './history-types.js';

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Fold per-model rows across a set of days into one list, desc by cost then tokens. */
export function aggregateModels(days: UsageDay[]): UsageModelStat[] {
  const byModel = new Map<string, UsageModelStat>();
  for (const day of days) {
    for (const m of day.models) {
      const acc = byModel.get(m.model) ?? {
        model: m.model,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      };
      acc.cost += m.cost;
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.cacheCreationTokens += m.cacheCreationTokens;
      acc.cacheReadTokens += m.cacheReadTokens;
      acc.totalTokens += m.totalTokens;
      byModel.set(m.model, acc);
    }
  }
  return [...byModel.values()]
    .map((m) => ({ ...m, cost: round(m.cost) }))
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
}

/** Window-wide totals + the honest cache derivations, computed from day rows. */
export function totalsFrom(days: UsageDay[]): UsageTotals {
  const t = zeroTotals();
  for (const d of days) {
    t.cost += d.cost;
    t.inputTokens += d.inputTokens;
    t.outputTokens += d.outputTokens;
    t.cacheCreationTokens += d.cacheCreationTokens;
    t.cacheReadTokens += d.cacheReadTokens;
    t.totalTokens += d.totalTokens;
  }
  t.cost = round(t.cost);
  t.processedTokens = t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
  t.freshInputTokens = t.inputTokens + t.cacheCreationTokens;
  t.cacheReadShare = t.processedTokens > 0 ? t.cacheReadTokens / t.processedTokens : 0;
  t.cacheLeverage = t.freshInputTokens > 0 ? t.cacheReadTokens / t.freshInputTokens : 0;
  t.days = days.length;
  t.firstDate = days.length ? (days[0] as UsageDay).date : null;
  t.lastDate = days.length ? (days[days.length - 1] as UsageDay).date : null;
  return t;
}

/**
 * Combine multiple machines' records for the SAME date into one day: sum token
 * counts + cost, merge per-model stats by name, union the agent list. Used when
 * the ledger flattens machine → date → day into a single cross-machine series.
 */
export function combineDays(date: string, records: UsageDay[]): UsageDay {
  const models = new Map<string, UsageModelStat>();
  const agents = new Set<string>();
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  for (const d of records) {
    cost += d.cost;
    inputTokens += d.inputTokens;
    outputTokens += d.outputTokens;
    cacheCreationTokens += d.cacheCreationTokens;
    cacheReadTokens += d.cacheReadTokens;
    totalTokens += d.totalTokens;
    for (const a of d.agents) agents.add(a);
    for (const m of d.models) {
      const acc = models.get(m.model) ?? {
        model: m.model,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      };
      acc.cost += m.cost;
      acc.inputTokens += m.inputTokens;
      acc.outputTokens += m.outputTokens;
      acc.cacheCreationTokens += m.cacheCreationTokens;
      acc.cacheReadTokens += m.cacheReadTokens;
      acc.totalTokens += m.totalTokens;
      models.set(m.model, acc);
    }
  }
  return {
    date,
    agents: [...agents].sort(),
    cost: round(cost),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    models: [...models.values()]
      .map((m) => ({ ...m, cost: round(m.cost) }))
      .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
  };
}
