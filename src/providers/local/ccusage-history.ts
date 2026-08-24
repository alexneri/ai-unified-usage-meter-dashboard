// ccusage DAILY history reader — UNOFFICIAL / best-effort, sibling of ccusage.ts.
// Where ccusage.ts collapses everything into a single spend/tokens meter for a
// card, this one keeps the full per-day, per-model breakdown for the cost &
// usage-history screen. Same source (local JSONL via `npx ccusage … --json`),
// same fail-soft contract (never throws to the caller of the collector), same
// test-injection seam (CCUSAGE_DAILY_JSON / CCUSAGE_CMD).

import { execFile } from 'node:child_process';
import { ProviderError } from '../../core/normalize.js';
import type {
  UsageDay,
  UsageHistory,
  UsageModelStat,
  UsageTotals,
} from '../../core/history-types.js';
import { zeroTotals } from '../../core/history-types.js';

/** The subset of `ccusage daily --json` we consume (tolerant of shape drift). */
export interface CcusageModelBreakdown {
  modelName?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}
export interface CcusageDailyRow {
  period?: string; // 'YYYY-MM-DD'
  date?: string; // some builds use `date`
  totalCost?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  metadata?: { agents?: string[] };
  modelsUsed?: string[];
  modelBreakdowns?: CcusageModelBreakdown[];
}
export interface CcusageDailyJson {
  daily?: CcusageDailyRow[];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function mapModel(b: CcusageModelBreakdown): UsageModelStat {
  const inputTokens = num(b.inputTokens);
  const outputTokens = num(b.outputTokens);
  const cacheCreationTokens = num(b.cacheCreationTokens);
  const cacheReadTokens = num(b.cacheReadTokens);
  return {
    model: (b.modelName ?? 'unknown').trim() || 'unknown',
    cost: round(num(b.cost)),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
  };
}

function mapDay(row: CcusageDailyRow): UsageDay {
  const models = (row.modelBreakdowns ?? []).map(mapModel);
  const inputTokens = num(row.inputTokens);
  const outputTokens = num(row.outputTokens);
  const cacheCreationTokens = num(row.cacheCreationTokens);
  const cacheReadTokens = num(row.cacheReadTokens);
  const totalTokens =
    num(row.totalTokens) || inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  return {
    date: (row.period ?? row.date ?? '').slice(0, 10),
    agents: [...(row.metadata?.agents ?? [])],
    cost: round(num(row.totalCost)),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    models,
  };
}

/** Fold all days' per-model rows into one window-wide list, desc by cost then tokens. */
function aggregateModels(days: UsageDay[]): UsageModelStat[] {
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

function totalsFrom(days: UsageDay[]): UsageTotals {
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
 * Pure mapping: ccusage daily JSON → UsageHistory. No subprocess. Exported for
 * fixture tests. Never throws — a shapeless payload yields an error history.
 */
export function mapCcusageDaily(
  data: CcusageDailyJson,
  generatedAt = new Date().toISOString(),
): UsageHistory {
  if (!Array.isArray(data.daily)) {
    return {
      source: 'ccusage',
      confidence: 'unofficial',
      generatedAt,
      days: [],
      totals: zeroTotals(),
      models: [],
      error: { message: 'ccusage returned no daily[] array (output shape changed)', retriable: false },
    };
  }
  const days = data.daily
    .map(mapDay)
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    source: 'ccusage',
    confidence: 'unofficial',
    generatedAt,
    days,
    totals: totalsFrom(days),
    models: aggregateModels(days),
  };
}

/** Pull the first JSON object out of ccusage stdout (it may print a banner first). */
export function extractDailyJson(stdout: string): CcusageDailyJson | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as CcusageDailyJson;
  } catch {
    return null;
  }
}

/** Spawn `npx ccusage daily --json`. Rejects (fail-soft up the stack) if absent/broken. */
export function runCcusageDaily(timeoutMs = 20000): Promise<CcusageDailyJson> {
  // Test/dev injection: skip the subprocess entirely if a payload is provided.
  const injected = process.env.CCUSAGE_DAILY_JSON;
  if (injected) {
    try {
      return Promise.resolve(JSON.parse(injected) as CcusageDailyJson);
    } catch {
      return Promise.reject(new ProviderError('CCUSAGE_DAILY_JSON is not valid JSON', { retriable: false }));
    }
  }
  return new Promise((resolve, reject) => {
    const cmd = process.env.CCUSAGE_CMD || 'npx';
    const args = process.env.CCUSAGE_CMD ? ['daily', '--json'] : ['ccusage@latest', 'daily', '--json'];
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(
          new ProviderError('ccusage/npx not available — install Node/npx to enable usage history', {
            retriable: false,
          }),
        );
      }
      if (err && !stdout) {
        return reject(new ProviderError(`ccusage daily failed: ${err.message}`, { retriable: true }));
      }
      const json = extractDailyJson(stdout ?? '');
      if (!json) return reject(new ProviderError('ccusage daily returned no parseable JSON', { retriable: false }));
      resolve(json);
    });
  });
}
