#!/usr/bin/env node
// seed-ledger.mjs — merge one or more `ccusage daily --json` snapshots into the
// durable ledger (.data/ledger.json), keyed by machine, keeping the highest value
// per day (same anti-decay rule as the collector). Use it to recover history that
// log-rotation already pruned from ccusage, by replaying a snapshot you saved when
// the data still existed.
//
// Usage:
//   node scripts/seed-ledger.mjs <machineId> <snapshot.json> [<snapshot.json> ...]
//
// Snapshots are raw `ccusage daily --json` output (a leading banner is tolerated).
// Does NOT run the collector; it only writes .data/ledger.json. Restart the
// collector afterwards so it loads the seeded ledger.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [machine, ...files] = process.argv.slice(2);
if (!machine || files.length === 0) {
  console.error('usage: node scripts/seed-ledger.mjs <machineId> <snapshot.json> [<snapshot.json> ...]');
  process.exit(2);
}

const LEDGER = resolve(process.cwd(), '.data/ledger.json');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (n) => Math.round(n * 1e6) / 1e6;

function mapDay(row) {
  const models = (row.modelBreakdowns ?? []).map((b) => {
    const i = num(b.inputTokens);
    const o = num(b.outputTokens);
    const cc = num(b.cacheCreationTokens);
    const cr = num(b.cacheReadTokens);
    return {
      model: (b.modelName ?? 'unknown').trim() || 'unknown',
      cost: round(num(b.cost)),
      inputTokens: i,
      outputTokens: o,
      cacheCreationTokens: cc,
      cacheReadTokens: cr,
      totalTokens: i + o + cc + cr,
    };
  });
  const i = num(row.inputTokens);
  const o = num(row.outputTokens);
  const cc = num(row.cacheCreationTokens);
  const cr = num(row.cacheReadTokens);
  return {
    date: String(row.period ?? row.date ?? '').slice(0, 10),
    agents: [...(row.metadata?.agents ?? [])],
    cost: round(num(row.totalCost)),
    inputTokens: i,
    outputTokens: o,
    cacheCreationTokens: cc,
    cacheReadTokens: cr,
    totalTokens: num(row.totalTokens) || i + o + cc + cr,
    models,
  };
}

function extract(s) {
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { version: 1, machines: {} };
if (!ledger.machines) ledger.machines = {};
const slice = ledger.machines[machine] ?? (ledger.machines[machine] = {});

let merged = 0;
for (const f of files) {
  const data = extract(readFileSync(f, 'utf8'));
  for (const row of data.daily ?? []) {
    const d = mapDay(row);
    if (!d.date) continue;
    const prev = slice[d.date];
    if (!prev || d.cost > prev.cost || (d.cost === prev.cost && d.totalTokens > prev.totalTokens)) {
      slice[d.date] = d;
      merged += 1;
    }
  }
}

mkdirSync(dirname(LEDGER), { recursive: true });
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));

const dates = Object.keys(slice).sort();
const total = Object.values(slice).reduce((a, d) => a + d.cost, 0);
console.log(
  `seeded machine=${machine}: ${dates.length} days (${dates[0] ?? '-'} → ${dates.at(-1) ?? '-'}), ` +
    `$${total.toFixed(2)}, ${merged} day(s) written from ${files.length} snapshot(s) → ${LEDGER}`,
);
