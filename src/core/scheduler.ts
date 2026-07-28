// Scheduler — TTL polling, stagger, read-through cache. Architecture §4 (shape),
// §2 (poll/read lifecycle), §10 (data flow). One process, one scheduler.

import type { CacheStore } from './cache.js';
import { markStale, redact } from './normalize.js';
import type { ProviderCredentials, ProviderSnapshot, UsageProvider } from './types.js';

/** Binding contract — Architecture §4. */
export interface Scheduler {
  register(p: UsageProvider): void;
  tick(): Promise<void>; // poll due providers (per-TTL), staggered
  snapshotAll(): Promise<ProviderSnapshot[]>; // read-through; mark 'stale'; kick refresh
}

/** Per-provider liveness for /api/health (no usage values, no secrets). */
export interface ProviderHealth {
  id: string;
  lastFetchedAt: string | null;
  ok: boolean;
}

/** Resolve the credentials for a provider id (config.ts supplies this). */
export type CredentialResolver = (providerId: string) => ProviderCredentials;

interface Entry {
  provider: UsageProvider;
  lastFetchedAt: number | null; // epoch ms of the last successful-or-error poll
  lastOk: boolean;
  inFlight: boolean;
}

export interface SchedulerOptions {
  cache: CacheStore;
  resolveCredentials: CredentialResolver;
  periodDays?: 7 | 30;
  /** Stagger between provider poll offsets, ms. Avoids a thundering herd. */
  staggerMs?: number;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Structured log sink; every message is redacted before it lands here. */
  log?: (msg: string) => void;
}

export class PollingScheduler implements Scheduler {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private timers = new Set<ReturnType<typeof setInterval>>();
  private started = false;

  private readonly cache: CacheStore;
  private readonly resolveCredentials: CredentialResolver;
  private readonly periodDays: 7 | 30;
  private readonly staggerMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: SchedulerOptions) {
    this.cache = opts.cache;
    this.resolveCredentials = opts.resolveCredentials;
    this.periodDays = opts.periodDays ?? 30;
    this.staggerMs = opts.staggerMs ?? 2000;
    this.now = opts.now ?? (() => Date.now());
    this.log = (msg) => (opts.log ?? (() => {}))(redact(msg));
  }

  register(p: UsageProvider): void {
    if (this.entries.has(p.id)) return;
    this.entries.set(p.id, { provider: p, lastFetchedAt: null, lastOk: false, inFlight: false });
    this.order.push(p.id);
  }

  /** Poll every provider that is due right now (used at boot and in tests). */
  async tick(): Promise<void> {
    const due = this.order.filter((id) => this.isDue(id));
    await Promise.all(due.map((id) => this.poll(id)));
  }

  private isDue(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.inFlight) return false;
    if (e.lastFetchedAt === null) return true;
    const ageMs = this.now() - e.lastFetchedAt;
    return ageMs >= e.provider.cacheTtlSeconds * 1000;
  }

  /** Run one provider's adapter, store the result (fail-soft: adapters never throw). */
  private async poll(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.inFlight) return;
    e.inFlight = true;
    try {
      const creds = this.resolveCredentials(id);
      const snap = await e.provider.fetch(creds, { periodDays: this.periodDays });
      // Retriable failures (429, 5xx, network): keep last-good meters in cache when
      // we have them. Overwriting with an empty error card makes a transient blip
      // look like a permanent outage (Claude Code 429 after collector restart).
      if (snap.error?.retriable) {
        const prev = await this.cache.get(id);
        if (prev && !prev.error && prev.meters.length > 0) {
          e.lastFetchedAt = this.now();
          e.lastOk = false;
          this.log(`polled ${id} ok=false retriable (kept last-good): ${snap.error.message}`);
          return;
        }
      }
      await this.cache.set(id, snap, e.provider.cacheTtlSeconds);
      e.lastFetchedAt = this.now();
      e.lastOk = !snap.error;
      this.log(`polled ${id} ok=${e.lastOk}`);
    } catch (err) {
      // Defensive: the contract says adapters never throw, but if one does we keep
      // last-good in cache and mark this provider failing rather than crash the loop.
      e.lastFetchedAt = this.now();
      e.lastOk = false;
      this.log(`poll ${id} threw (kept last-good): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.inFlight = false;
    }
  }

  /**
   * Read-through snapshot of ALL registered providers.
   *  - never-fetched provider → present with an empty placeholder snapshot (not omitted)
   *  - entry past its TTL      → returned freshness:'stale' + a background refresh is kicked
   *  - request path makes NO synchronous provider call.
   */
  async snapshotAll(): Promise<ProviderSnapshot[]> {
    const out: ProviderSnapshot[] = [];
    for (const id of this.order) {
      const e = this.entries.get(id)!;
      const cached = await this.cache.get(id);
      if (!cached) {
        out.push(this.neverFetched(e.provider));
        void this.kick(id);
        continue;
      }
      if (this.isStale(e, cached)) {
        out.push(markStale(cached));
        void this.kick(id);
      } else {
        out.push(cached);
      }
    }
    return out;
  }

  private isStale(e: Entry, snap: ProviderSnapshot): boolean {
    if (snap.error) return true;
    // Prefer the scheduler's own poll time (same clock as now()); fall back to the
    // snapshot's wall-clock fetchedAt when this process hasn't polled yet (e.g. a
    // fresh boot reading last-good from JsonFileCache).
    const ref = e.lastFetchedAt ?? Date.parse(snap.fetchedAt);
    if (ref === null || Number.isNaN(ref)) return true;
    return this.now() - ref >= e.provider.cacheTtlSeconds * 1000;
  }

  /** Fire-and-forget background refresh; guarded against duplicates via inFlight. */
  private kick(id: string): Promise<void> {
    if (!this.isDue(id)) return Promise.resolve();
    return this.poll(id).catch(() => {});
  }

  private neverFetched(p: UsageProvider): ProviderSnapshot {
    // Empty meters + no error → the UI renders a "never-fetched" skeleton, not an
    // error card and not a missing card (front-end spec State Matrix).
    return {
      providerId: p.id,
      displayName: p.displayName,
      meters: [],
      confidence: p.confidence,
      freshness: 'stale',
      fetchedAt: new Date(0).toISOString(),
    };
  }

  /** Per-provider liveness for /api/health. No usage values, no secrets. */
  health(): ProviderHealth[] {
    return this.order.map((id) => {
      const e = this.entries.get(id)!;
      return {
        id,
        lastFetchedAt: e.lastFetchedAt === null ? null : new Date(e.lastFetchedAt).toISOString(),
        ok: e.lastOk,
      };
    });
  }

  /** Start staggered background polling. Each provider gets its own interval,
   *  offset by staggerMs, so polls don't align into a thundering herd. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.order.forEach((id, i) => {
      const e = this.entries.get(id)!;
      const offset = i * this.staggerMs;
      const period = e.provider.cacheTtlSeconds * 1000;
      const timer = setTimeout(() => {
        void this.poll(id);
        const interval = setInterval(() => void this.poll(id), period);
        this.timers.add(interval);
      }, offset);
      this.timers.add(timer);
    });
  }

  stop(): void {
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers.clear();
    this.started = false;
  }
}
