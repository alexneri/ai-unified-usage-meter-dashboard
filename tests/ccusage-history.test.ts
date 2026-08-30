import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractDailyJson,
  mapCcusageDaily,
  runCcusageDaily,
  type CcusageDailyJson,
} from '../src/providers/local/ccusage-history.js';
import { HistoryCollector } from '../src/core/history.js';
import { toCumulative } from '../src/core/history-types.js';

const FIX = resolve(__dirname, '../fixtures/ccusage');
const daily = JSON.parse(readFileSync(resolve(FIX, 'daily-history.json'), 'utf8')) as CcusageDailyJson;

describe('mapCcusageDaily (fixture → usage history)', () => {
  const h = mapCcusageDaily(daily, '2026-08-04T00:00:00.000Z');

  it('keeps one row per day, ascending, with agents and per-model breakdown', () => {
    expect(h.error).toBeUndefined();
    expect(h.days.map((d) => d.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    const d0 = h.days[0]!;
    expect(d0.cost).toBe(3);
    expect(d0.totalTokens).toBe(13500);
    expect(d0.cacheReadTokens).toBe(10000);
    expect(d0.agents).toEqual(['claude']);
    expect(d0.models).toHaveLength(1);
    expect(h.days[2]!.agents).toEqual(['claude', 'openclaw']);
    expect(h.days[2]!.models).toHaveLength(2);
  });

  it('aggregates window totals straight from the day rows', () => {
    expect(h.totals.cost).toBe(10);
    expect(h.totals.totalTokens).toBe(46900);
    expect(h.totals.inputTokens).toBe(3600);
    expect(h.totals.outputTokens).toBe(1800);
    expect(h.totals.cacheCreationTokens).toBe(3500);
    expect(h.totals.cacheReadTokens).toBe(38000);
    expect(h.totals.days).toBe(3);
    expect(h.totals.firstDate).toBe('2026-08-01');
    expect(h.totals.lastDate).toBe('2026-08-03');
  });

  it('derives the honest cache metrics (share + token-reuse leverage)', () => {
    // processed = 46900, freshInput = input(3600)+cacheCreation(3500) = 7100
    expect(h.totals.processedTokens).toBe(46900);
    expect(h.totals.freshInputTokens).toBe(7100);
    expect(h.totals.cacheReadShare).toBeCloseTo(38000 / 46900, 6);
    expect(h.totals.cacheLeverage).toBeCloseTo(38000 / 7100, 6);
  });

  it('folds per-model stats window-wide, desc by cost then tokens (tie → more tokens first)', () => {
    // gpt-5.2 and claude-opus-4-8 both total $5; gpt-5.2 has more tokens so it leads.
    expect(h.models.map((m) => m.model)).toEqual(['gpt-5.2', 'claude-opus-4-8', '[openclaw] claude-opus-4-8']);
    const claude = h.models.find((m) => m.model === 'claude-opus-4-8')!;
    expect(claude.cost).toBe(5);
    expect(claude.cacheReadTokens).toBe(15000);
    expect(claude.totalTokens).toBe(20250);
    // $0 (no public pricing) rows are kept, not dropped.
    expect(h.models.find((m) => m.model === '[openclaw] claude-opus-4-8')!.cost).toBe(0);
  });

  it('passes generatedAt through', () => {
    expect(h.generatedAt).toBe('2026-08-04T00:00:00.000Z');
  });

  it('degrades to a non-retriable error history when daily[] is absent', () => {
    const bad = mapCcusageDaily({} as CcusageDailyJson);
    expect(bad.error?.retriable).toBe(false);
    expect(bad.days).toEqual([]);
    expect(bad.totals.cost).toBe(0);
  });
});

describe('extractDailyJson', () => {
  it('pulls the JSON object out of stdout with a leading banner', () => {
    const out = 'ccusage v1.2\nLoading…\n{"daily":[{"period":"2026-08-01","totalCost":1}]}\n';
    expect(extractDailyJson(out)?.daily?.[0]?.totalCost).toBe(1);
  });

  it('returns null on unparseable stdout', () => {
    expect(extractDailyJson('no json here')).toBeNull();
  });
});

describe('runCcusageDaily (test injection seam)', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    for (const k of ['CCUSAGE_DAILY_JSON', 'CCUSAGE_CMD']) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  it('uses CCUSAGE_DAILY_JSON without spawning a subprocess', async () => {
    process.env.CCUSAGE_DAILY_JSON = JSON.stringify(daily);
    const json = await runCcusageDaily();
    expect(json.daily).toHaveLength(3);
  });

  it('rejects non-retriable on invalid injected JSON', async () => {
    process.env.CCUSAGE_DAILY_JSON = '{not json';
    await expect(runCcusageDaily()).rejects.toMatchObject({ retriable: false });
  });
});

describe('HistoryCollector (ledger-backed, fail-soft + read-through)', () => {
  const LP = resolve(__dirname, '../.data/history-collector.test.json');
  beforeEach(() => rmSync(LP, { force: true }));
  afterAll(() => rmSync(LP, { force: true }));

  it('refreshes from an injected runner and serves the aggregate read-through', async () => {
    const c = new HistoryCollector({
      ledgerPath: LP,
      machineId: 'test',
      run: async () => daily,
      now: () => Date.parse('2026-08-04T00:00:00.000Z'),
    });
    await c.refresh();
    const got = c.get();
    expect(got.days).toHaveLength(3);
    expect(got.totals.cost).toBe(10);
  });

  it('never lowers a recorded day when a later read shrinks (anti-decay)', async () => {
    let call = 0;
    const c = new HistoryCollector({
      ledgerPath: LP,
      machineId: 'test',
      run: async () => {
        call += 1;
        // 2nd read simulates log pruning: same dates, cost/tokens collapsed.
        return call === 1
          ? daily
          : { daily: (daily.daily ?? []).map((d) => ({ ...d, totalCost: 0, totalTokens: 0, modelBreakdowns: [] })) };
      },
    });
    await c.refresh(); // full read
    await c.refresh(); // pruned read must NOT lower the ledger
    expect(c.get().totals.cost).toBe(10);
    expect(c.get().days).toHaveLength(3);
  });

  it('keeps the ledger when a refresh throws', async () => {
    let call = 0;
    const c = new HistoryCollector({
      ledgerPath: LP,
      machineId: 'test',
      run: async () => {
        call += 1;
        if (call === 1) return daily;
        throw new Error('ccusage vanished');
      },
    });
    await c.refresh();
    await c.refresh();
    expect(c.get().days).toHaveLength(3);
    expect(c.get().totals.cost).toBe(10);
  });

  it('serves an empty placeholder before the first refresh', () => {
    const c = new HistoryCollector({
      ledgerPath: resolve(__dirname, '../.data/none.test.json'),
      machineId: 'test',
    });
    expect(c.get().days).toEqual([]);
    expect(c.get().totals.cost).toBe(0);
  });
});

describe('toCumulative (running spend curve)', () => {
  it('produces a running sum', () => {
    expect(toCumulative([1, 2, 3, 4])).toEqual([1, 3, 6, 10]);
  });

  it('handles empty and single-element series', () => {
    expect(toCumulative([])).toEqual([]);
    expect(toCumulative([5])).toEqual([5]);
  });

  it('last element equals the grand total (headline == end of curve)', () => {
    const xs = [3.5, 5, 2.25];
    const c = toCumulative(xs);
    expect(c[c.length - 1]).toBeCloseTo(
      xs.reduce((a, b) => a + b, 0),
      6,
    );
  });
});
