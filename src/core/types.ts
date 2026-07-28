// Core contracts — Architecture §4. These types are BINDING: every adapter and
// the UI depend on them exactly. Do not add fields or change shapes without
// updating docs/architecture.md §4 first.

export type MeterKind = 'spend' | 'tokens' | 'rate_limit' | 'quota' | 'balance';
export type Confidence = 'official' | 'unofficial'; // unofficial = undocumented/local, may break
export type Freshness = 'live' | 'historical' | 'stale';

/** One normalized meter shown on a card. */
export interface Meter {
  kind: MeterKind;
  label: string; // "Spend (30d)", "Weekly Codex", "Credits remaining"
  value: number;
  unit: 'usd' | 'tokens' | 'requests' | 'percent' | 'count';
  limit?: number; // when a cap/quota exists
  remaining?: number; // live remaining, when the provider exposes it
  resetsAt?: string; // ISO — for windowed quotas (5h / 7d)
  windowSeconds?: number;
}

/** Small time series for a sparkline (provider's own buckets). */
export interface Series {
  points: { t: string; v: number }[];
  unit: Meter['unit'];
}

/** What every adapter returns. NOTE: no credential field — this is the wire type. */
export interface ProviderSnapshot {
  providerId: string; // 'openrouter' | 'openai' | 'anthropic' | …
  displayName: string;
  meters: Meter[];
  sparkline?: Series;
  confidence: Confidence;
  freshness: Freshness;
  fetchedAt: string; // ISO
  error?: { message: string; retriable: boolean }; // fail-soft: card renders error state
}

/** Credentials handed to an adapter — NEVER serialized, NEVER leaves the collector. */
export interface ProviderCredentials {
  [k: string]: string | undefined;
}

/** The adapter contract — one file per provider. */
export interface UsageProvider {
  readonly id: string;
  readonly displayName: string;
  readonly confidence: Confidence; // official adapters vs best-effort local ones
  readonly cacheTtlSeconds: number; // 300–900 typical
  /** Pull + normalize. MUST NOT throw — return snapshot.error instead. */
  fetch(creds: ProviderCredentials, opts: { periodDays: 7 | 30 }): Promise<ProviderSnapshot>;
}
