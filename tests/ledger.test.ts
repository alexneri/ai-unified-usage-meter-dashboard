import { describe, expect, it } from 'vitest';
import type { UsageDay } from '../src/core/history-types.js';
import { aggregateLedger, emptyLedger, ledgerMachines, mergeMachineDays } from '../src/core/ledger.js';
import { combineDays } from '../src/core/history-aggregate.js';

function day(date: string, cost: number, model = 'm', tokens = Math.round(cost * 1000)): UsageDay {
  return {
    date,
    agents: ['a'],
    cost,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: tokens,
    models: [
      {
        model,
        cost,
        inputTokens: tokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: tokens,
      },
    ],
  };
}

describe('mergeMachineDays (anti-decay: keep the max per day)', () => {
  it('keeps the higher-cost observation and ignores a lower (pruned) re-read', () => {
    const l = emptyLedger();
    expect(mergeMachineDays(l, 'M', [day('2026-01-01', 10)])).toBe(1);
    expect(mergeMachineDays(l, 'M', [day('2026-01-01', 3)])).toBe(0); // shrunk read → ignored
    expect(l.machines.M!['2026-01-01']!.cost).toBe(10);
    expect(mergeMachineDays(l, 'M', [day('2026-01-01', 12)])).toBe(1); // grew → accepted
    expect(l.machines.M!['2026-01-01']!.cost).toBe(12);
  });

  it('adds new dates and tracks machines', () => {
    const l = emptyLedger();
    mergeMachineDays(l, 'M', [day('2026-01-01', 5), day('2026-01-02', 7)]);
    mergeMachineDays(l, 'N', [day('2026-01-01', 1)]);
    expect(Object.keys(l.machines.M!)).toHaveLength(2);
    expect(ledgerMachines(l)).toEqual(['M', 'N']);
  });
});

describe('aggregateLedger (sum across machines per date)', () => {
  it('sums two machines that used the same day and folds shared models', () => {
    const l = emptyLedger();
    mergeMachineDays(l, 'mac', [day('2026-01-01', 5, 'opus')]);
    mergeMachineDays(l, 'pc', [day('2026-01-01', 7, 'opus')]);
    const h = aggregateLedger(l, '2026-01-02T00:00:00.000Z');
    expect(h.days).toHaveLength(1);
    expect(h.days[0]!.cost).toBe(12);
    expect(h.totals.cost).toBe(12);
    expect(h.models).toHaveLength(1);
    expect(h.models[0]!.cost).toBe(12);
  });

  it('interleaves distinct dates across machines, ascending', () => {
    const l = emptyLedger();
    mergeMachineDays(l, 'mac', [day('2026-01-03', 3)]);
    mergeMachineDays(l, 'pc', [day('2026-01-01', 1)]);
    const h = aggregateLedger(l, 'x');
    expect(h.days.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-03']);
    expect(h.totals.cost).toBe(4);
    expect(h.totals.firstDate).toBe('2026-01-01');
    expect(h.totals.lastDate).toBe('2026-01-03');
  });

  it('empty ledger yields empty history', () => {
    const h = aggregateLedger(emptyLedger(), 'x');
    expect(h.days).toEqual([]);
    expect(h.totals.cost).toBe(0);
  });
});

describe('combineDays (merge machines on one date)', () => {
  it('sums tokens/cost, merges models by name, unions agents', () => {
    const a: UsageDay = { ...day('2026-01-01', 5, 'opus'), agents: ['claude'] };
    const b: UsageDay = { ...day('2026-01-01', 7, 'opus'), agents: ['codex'] };
    const c = combineDays('2026-01-01', [a, b]);
    expect(c.cost).toBe(12);
    expect(c.agents).toEqual(['claude', 'codex']);
    expect(c.models).toHaveLength(1);
    expect(c.models[0]!.model).toBe('opus');
    expect(c.models[0]!.cost).toBe(12);
  });
});
