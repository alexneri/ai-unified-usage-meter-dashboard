// Durable usage ledger — the fix for "cumulative spend keeps shrinking".
//
// ccusage reconstructs usage from LOCAL agent logs, which the agents prune (Claude
// Code deletes transcripts after cleanupPeriodDays, default 30). So a day's data
// vanishes ~30 days after it happened and any total summed straight from ccusage
// DECAYS. This ledger persists the highest observed value per (machine, date), so
// once a day is recorded a later shrunk/pruned read can never lower it — the
// cumulative total becomes monotonic and truly all-time.
//
// It is machine-KEYED from the start: a single collector fills its own machine's
// slice today; a future POST /api/usage/ingest lets other machines push their
// ccusage under their own key, and aggregateLedger() sums across all of them.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageDay, UsageHistory } from './history-types.js';
import { aggregateModels, combineDays, totalsFrom } from './history-aggregate.js';

export interface LedgerData {
  version: number;
  /** machineId → date(YYYY-MM-DD) → best-ever day record for that machine. */
  machines: Record<string, Record<string, UsageDay>>;
}

export function emptyLedger(): LedgerData {
  return { version: 1, machines: {} };
}

/**
 * Merge a machine's freshly-read days, keeping the higher-cost observation per
 * date (tie broken by more tokens). Returns the count of days that changed.
 * This is the anti-decay rule: a pruned re-read (lower cost) never overwrites a
 * fuller earlier read.
 */
export function mergeMachineDays(ledger: LedgerData, machine: string, days: UsageDay[]): number {
  const slice = ledger.machines[machine] ?? {};
  ledger.machines[machine] = slice;
  let changed = 0;
  for (const d of days) {
    if (!d.date) continue;
    const prev = slice[d.date];
    if (!prev || d.cost > prev.cost || (d.cost === prev.cost && d.totalTokens > prev.totalTokens)) {
      slice[d.date] = d;
      changed += 1;
    }
  }
  return changed;
}

/** Flatten the whole ledger into one UsageHistory (sum across machines per date). */
export function aggregateLedger(ledger: LedgerData, generatedAt: string): UsageHistory {
  const byDate = new Map<string, UsageDay[]>();
  for (const [, slice] of Object.entries(ledger.machines)) {
    for (const [date, day] of Object.entries(slice)) {
      const list = byDate.get(date);
      if (list) list.push(day);
      else byDate.set(date, [day]);
    }
  }
  const days = [...byDate.entries()]
    .map(([date, records]) => combineDays(date, records))
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

/** How many distinct machines have contributed to the ledger. */
export function ledgerMachines(ledger: LedgerData): string[] {
  return Object.keys(ledger.machines).sort();
}

export async function loadLedger(path: string): Promise<LedgerData> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LedgerData>;
    if (parsed && parsed.machines && typeof parsed.machines === 'object') {
      return { version: parsed.version ?? 1, machines: parsed.machines as LedgerData['machines'] };
    }
  } catch {
    // No file yet / unreadable — start empty. Not fatal.
  }
  return emptyLedger();
}

export async function saveLedger(path: string, ledger: LedgerData): Promise<void> {
  const json = JSON.stringify(ledger, null, 2);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, path);
}
