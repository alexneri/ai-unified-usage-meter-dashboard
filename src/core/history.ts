// HistoryCollector — background poller feeding the durable ledger. On each tick it
// reads local ccusage, merges the highest-per-day values into the machine-keyed
// ledger (see ledger.ts for the anti-decay rationale), persists it, and caches the
// cross-machine aggregate. /api/usage serves that aggregate read-through — no
// subprocess on the request path.

import { redact } from './normalize.js';
import type { UsageHistory } from './history-types.js';
import { emptyHistory } from './history-types.js';
import { aggregateLedger, loadLedger, mergeMachineDays, saveLedger, type LedgerData } from './ledger.js';
import {
  mapCcusageDaily,
  runCcusageDaily,
  type CcusageDailyJson,
} from '../providers/local/ccusage-history.js';

export interface HistoryCollectorOptions {
  /** Where the durable ledger is persisted (atomic). Gitignored (.data/…). */
  ledgerPath: string;
  /** This machine's id — the ledger slice this collector fills. */
  machineId: string;
  /** Refresh cadence, ms. Default 15 min (matches the ccusage card TTL). */
  refreshMs?: number;
  /** Injected ccusage runner (tests). Defaults to the real subprocess. */
  run?: () => Promise<CcusageDailyJson>;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Redacted log sink. */
  log?: (msg: string) => void;
}

export class HistoryCollector {
  private ledger: LedgerData | null = null;
  private latest: UsageHistory | null = null;
  private inFlight = false;
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly ledgerPath: string;
  private readonly machineId: string;
  private readonly refreshMs: number;
  private readonly run: () => Promise<CcusageDailyJson>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: HistoryCollectorOptions) {
    this.ledgerPath = opts.ledgerPath;
    this.machineId = opts.machineId;
    this.refreshMs = opts.refreshMs ?? 15 * 60 * 1000;
    this.run = opts.run ?? (() => runCcusageDaily());
    this.now = opts.now ?? (() => Date.now());
    this.log = (msg) => (opts.log ?? (() => {}))(redact(msg));
  }

  /** Load the persisted ledger so a fresh boot already serves accumulated history. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.ledger = await loadLedger(this.ledgerPath);
    this.latest = aggregateLedger(this.ledger, new Date(this.now()).toISOString());
  }

  /** Read local ccusage, merge into the ledger (anti-decay), persist, re-aggregate. */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      if (!this.ledger) this.ledger = await loadLedger(this.ledgerPath);
      const mapped = mapCcusageDaily(await this.run(), new Date(this.now()).toISOString());
      if (mapped.error && mapped.days.length === 0) {
        this.log(`history refresh: ccusage error (${mapped.error.message}); ledger kept`);
      } else {
        const changed = mergeMachineDays(this.ledger, this.machineId, mapped.days);
        if (changed > 0) await saveLedger(this.ledgerPath, this.ledger);
        this.log(`history: merged ${changed} day(s) for ${this.machineId}`);
      }
      this.latest = aggregateLedger(this.ledger, new Date(this.now()).toISOString());
      this.log(`history: ${this.latest.days.length}d, $${this.latest.totals.cost.toFixed(2)} cumulative`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (this.ledger) this.latest = aggregateLedger(this.ledger, new Date(this.now()).toISOString());
      this.log(`history refresh threw (ledger kept): ${message}`);
    } finally {
      this.inFlight = false;
    }
  }

  /** Read-through: the cross-machine aggregate, or an empty placeholder. */
  get(): UsageHistory {
    return this.latest ?? emptyHistory();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
