// HistoryCollector — background poller for the usage-history screen. Mirrors the
// scheduler's contract (poll on a TTL, serve read-through last-good, survive a
// restart via an atomic JSON file) but stays OUT of the ProviderSnapshot pipeline
// because the history payload is a different shape (§4 snapshot invariant).
//
// The /api/usage handler does NO subprocess work on the request path — it returns
// whatever this collector last computed, exactly like /api/snapshot reads cache.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redact } from './normalize.js';
import type { UsageHistory } from './history-types.js';
import { emptyHistory } from './history-types.js';
import { mapCcusageDaily, runCcusageDaily, type CcusageDailyJson } from '../providers/local/ccusage-history.js';

export interface HistoryCollectorOptions {
  /** Where last-good history is persisted (atomic). Gitignored (.data/…). */
  persistPath: string;
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
  private latest: UsageHistory | null = null;
  private inFlight = false;
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly persistPath: string;
  private readonly refreshMs: number;
  private readonly run: () => Promise<CcusageDailyJson>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: HistoryCollectorOptions) {
    this.persistPath = opts.persistPath;
    this.refreshMs = opts.refreshMs ?? 15 * 60 * 1000;
    this.run = opts.run ?? (() => runCcusageDaily());
    this.now = opts.now ?? (() => Date.now());
    this.log = (msg) => (opts.log ?? (() => {}))(redact(msg));
  }

  /** Load persisted last-good history (best-effort) so a fresh boot serves data. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as UsageHistory;
      if (parsed && Array.isArray(parsed.days) && parsed.totals) this.latest = parsed;
    } catch {
      // No file yet / unreadable — start empty. Not fatal.
    }
  }

  /** Run ccusage, remap, store. Fail-soft: keep last-good on failure; only the
   *  very first failure with no prior data surfaces an error history. */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const json = await this.run();
      const mapped = mapCcusageDaily(json, new Date(this.now()).toISOString());
      if (mapped.error && this.latest && this.latest.days.length > 0) {
        this.log(`history refresh error (kept last-good ${this.latest.days.length}d): ${mapped.error.message}`);
        return;
      }
      this.latest = mapped;
      await this.persist();
      this.log(`history refreshed: ${mapped.days.length}d, $${mapped.totals.cost.toFixed(2)} est`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!this.latest) {
        this.latest = { ...emptyHistory(new Date(this.now()).toISOString()), error: { message: redact(message), retriable: true } };
      }
      this.log(`history refresh threw (kept last-good): ${message}`);
    } finally {
      this.inFlight = false;
    }
  }

  /** Read-through: last-good history, or an empty placeholder. Never subprocess. */
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

  private async persist(): Promise<void> {
    if (!this.latest) return;
    const json = JSON.stringify(this.latest, null, 2);
    await mkdir(dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, this.persistPath);
  }
}
