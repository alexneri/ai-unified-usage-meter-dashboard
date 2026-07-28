// Normalization helpers shared by every adapter and the collector core.
// Architecture §5 (core/normalize.ts): usd(), errorSnapshot(), markStale(), redact().

import type { Confidence, Meter, ProviderSnapshot } from './types.js';

/**
 * A typed error an adapter may throw internally to signal retriability.
 * Adapters still MUST NOT let it escape — they catch and pass it to errorSnapshot().
 */
export class ProviderError extends Error {
  readonly retriable: boolean;
  readonly status?: number;
  constructor(message: string, opts: { retriable: boolean; status?: number } = { retriable: true }) {
    super(message);
    this.name = 'ProviderError';
    this.retriable = opts.retriable;
    this.status = opts.status;
  }
}

/** Format a USD number for meter values (kept as a number in the meter; this is for logs/labels). */
export function usd(n: number): string {
  const abs = Math.abs(n);
  const digits = abs < 1 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

/**
 * Classify an unknown error into retriable/non-retriable and produce a well-formed
 * ProviderSnapshot with `error` set and empty meters. Adapters NEVER throw — they
 * return errorSnapshot(...) instead (Architecture §6).
 *
 * Classification:
 *   - network / timeout / 5xx        → retriable
 *   - auth (401/403) / org-only /
 *     format-change / bad-config     → non-retriable
 */
export function errorSnapshot(
  id: string,
  name: string,
  e: unknown,
  confidence: Confidence = 'official',
): ProviderSnapshot {
  const { message, retriable } = classifyError(e);
  return {
    providerId: id,
    displayName: name,
    meters: [],
    confidence,
    freshness: 'stale',
    fetchedAt: new Date().toISOString(),
    error: { message, retriable },
  };
}

function classifyError(e: unknown): { message: string; retriable: boolean } {
  if (e instanceof ProviderError) {
    return { message: redact(e.message), retriable: e.retriable };
  }
  const raw = e instanceof Error ? e.message : String(e);
  const msg = redact(raw);
  const lower = raw.toLowerCase();

  // Non-retriable signals: auth, permission, org-only, config, format drift.
  const nonRetriable =
    /\b(401|403|unauthorized|forbidden|invalid.*key|bad.*key|org-only|organization|not configured|misconfig|schema|unexpected (response|shape|format))\b/.test(
      lower,
    );
  if (nonRetriable) return { message: msg, retriable: false };

  // Everything else (network, timeout, 5xx, unknown) is treated as retriable.
  return { message: msg, retriable: true };
}

/** Return a copy of the snapshot marked stale (last-good data preserved). */
export function markStale(snap: ProviderSnapshot): ProviderSnapshot {
  if (snap.freshness === 'stale') return snap;
  return { ...snap, freshness: 'stale' };
}

/**
 * Redact key/token-like values from any string so nothing sensitive is logged.
 * Matches provider key prefixes (sk-, sk-or-, sk-admin, sk-ant-…) and bearer/auth
 * header values. Used in every logging path (NFR3).
 */
export function redact(input: string): string {
  return input
    .replace(/\b(sk-(?:or-|ant-|admin|proj-|live-)?[A-Za-z0-9_-]{6,})\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(xai-[A-Za-z0-9_-]{6,})\b/g, '[redacted-key]');
}

/** Redact a whole object graph for structured logging — never mutate the input. */
export function redactObject(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Drop obviously sensitive keys entirely.
      if (/(key|token|secret|authorization|password|cookie)/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactObject(v);
      }
    }
    return out;
  }
  return value;
}

/** Small helper to build a Meter without repeating optional-field boilerplate. */
export function meter(m: Meter): Meter {
  return m;
}
