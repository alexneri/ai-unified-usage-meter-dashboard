// Local Codex / ChatGPT quota reader — UNOFFICIAL / best-effort. Architecture §6
// (local/codex), Story 3.2.
//
// Shows the ChatGPT/Codex 5-hour + weekly usage windows from the *local* Codex
// client, so the "Codex bar" lives on the same board as everything else. Path:
//
//   1. `codex app-server` JSON-RPC `account/rateLimits/read` → primary/secondary
//      windows (used_percent + reset) and optional credits.
//   2. (documented fallback) parse `codex` CLI `/status` if the app-server path
//      is unavailable.
//
// This is explicitly NOT a stable interface (OpenAI issue #24080). On THIS Mac the
// vendored `@openai/codex` binary is broken (ENOENT under aarch64-apple-darwin), so
// the adapter must fail-soft with a clear message — a version/format mismatch or a
// missing binary yields a non-retriable "unofficial endpoint changed" error, never
// silently-wrong numbers. No web scraping (NFR7); local CLI/creds only.

import { execFile } from 'node:child_process';
import { errorSnapshot, ProviderError } from '../../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../../core/types.js';
import { readCodexAuth } from './credentials.js';

/** One rate-limit window as reported by `account/rateLimits/read` (tolerant variants). */
export interface CodexWindow {
  used_percent?: number; // 0–100
  window_minutes?: number;
  resets_in_seconds?: number;
  reset_at?: string; // ISO (alternative to resets_in_seconds)
}

/** The JSON-RPC `account/rateLimits/read` result we consume. */
export interface CodexRateLimits {
  primary_window?: CodexWindow | null;
  secondary_window?: CodexWindow | null;
  // Some client versions nest under `rate_limits`; accept both.
  rate_limits?: { primary?: CodexWindow; secondary?: CodexWindow } | null;
  credits?: { balance?: number; currency?: string } | number | null;
}

function pick(rl: CodexRateLimits, which: 'primary' | 'secondary'): CodexWindow | null {
  const flat = which === 'primary' ? rl.primary_window : rl.secondary_window;
  const nested = which === 'primary' ? rl.rate_limits?.primary : rl.rate_limits?.secondary;
  return flat ?? nested ?? null;
}

function windowMeter(label: string, w: CodexWindow | null, fetchedMs: number): Meter | null {
  if (!w || typeof w.used_percent !== 'number' || Number.isNaN(w.used_percent)) return null;
  const used = Math.max(0, Math.min(100, round(w.used_percent)));
  const windowSeconds = typeof w.window_minutes === 'number' ? w.window_minutes * 60 : undefined;
  let resetsAt = w.reset_at;
  if (!resetsAt && typeof w.resets_in_seconds === 'number') {
    resetsAt = new Date(fetchedMs + w.resets_in_seconds * 1000).toISOString();
  }
  return {
    kind: 'quota',
    label,
    value: used, // percent USED
    unit: 'percent',
    limit: 100,
    remaining: round(100 - used), // percent LEFT
    resetsAt,
    windowSeconds,
  };
}

function creditsMeter(rl: CodexRateLimits): Meter | null {
  const c = rl.credits;
  const balance = typeof c === 'number' ? c : typeof c?.balance === 'number' ? c.balance : null;
  if (balance === null) return null;
  return { kind: 'balance', label: 'Credits', value: round(balance), unit: 'usd', remaining: round(balance) };
}

/**
 * Pure mapping: `account/rateLimits/read` result → 5h + weekly quota meters.
 * No subprocess, no secrets. Exported for fixture tests.
 */
export function mapCodexRateLimits(rl: CodexRateLimits, fetchedAt = new Date().toISOString()): ProviderSnapshot {
  const fetchedMs = Date.parse(fetchedAt);
  const meters: Meter[] = [];
  const primary = windowMeter('5-hour window', pick(rl, 'primary'), fetchedMs);
  const secondary = windowMeter('Weekly window', pick(rl, 'secondary'), fetchedMs);
  if (primary) meters.push(primary);
  if (secondary) meters.push(secondary);
  const credits = creditsMeter(rl);
  if (credits) meters.push(credits);

  if (meters.length === 0) {
    return errorSnapshot(
      'codex',
      'Codex',
      new ProviderError('Codex rate-limit response had no recognizable windows (unofficial endpoint changed)', {
        retriable: false,
      }),
      'unofficial',
    );
  }

  return {
    providerId: 'codex',
    displayName: 'Codex',
    meters,
    confidence: 'unofficial',
    freshness: 'live',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Ask `codex app-server` for rate limits over JSON-RPC (newline-delimited on
 * stdout). Best-effort: spawns the binary, sends initialize + the read request,
 * and resolves with the first matching result. Rejects (fail-soft up the stack)
 * on a missing/broken binary or a timeout.
 */
function readViaAppServer(bin: string, timeoutMs = 4000): Promise<CodexRateLimits> {
  return new Promise((resolve, reject) => {
    // execFile buffers stdio and surfaces ENOENT cleanly; we feed both JSON-RPC
    // frames on stdin and parse whatever line-delimited JSON comes back.
    const child = execFile(
      bin,
      ['app-server'],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => {
        // A broken vendored binary throws ENOENT here → clear non-retriable error.
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(
            new ProviderError('Codex CLI not found (broken/absent binary) — the local Codex reader is unavailable', {
              retriable: false,
            }),
          );
        }
        const parsed = parseRpcRateLimits(stdout ?? '');
        if (parsed) return resolve(parsed);
        return reject(
          new ProviderError(
            'Codex app-server did not return rate limits (broken CLI / unofficial endpoint changed)',
            { retriable: false },
          ),
        );
      },
    );
    // JSON-RPC handshake then the read; harmless if the binary ignores stdin.
    try {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`,
      );
      child.stdin?.end();
    } catch {
      // Broken pipe on a dead binary — the execFile callback handles the error.
    }
  });
}

/** Extract a rate-limits result from newline-delimited JSON-RPC output. */
export function parseRpcRateLimits(stdout: string): CodexRateLimits | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const msg = JSON.parse(trimmed) as { result?: CodexRateLimits };
      if (msg.result && (msg.result.primary_window || msg.result.secondary_window || msg.result.rate_limits)) {
        return msg.result;
      }
    } catch {
      // Not a JSON-RPC frame; keep scanning.
    }
  }
  return null;
}

export const codex: UsageProvider = {
  id: 'codex',
  displayName: 'Codex',
  confidence: 'unofficial',
  cacheTtlSeconds: 300,
  async fetch(_creds: ProviderCredentials): Promise<ProviderSnapshot> {
    try {
      // Presence of a local login is the precondition; the token itself is never
      // placed in the snapshot and is not needed for the app-server call.
      const auth = readCodexAuth();
      if (!auth?.tokens?.access_token && !auth?.OPENAI_API_KEY) {
        return errorSnapshot(
          'codex',
          'Codex',
          new ProviderError('No local Codex login found (~/.codex/auth.json) — run `codex login`', {
            retriable: false,
          }),
          'unofficial',
        );
      }
      const bin = process.env.CODEX_BIN || 'codex';
      const rl = await readViaAppServer(bin);
      return mapCodexRateLimits(rl);
    } catch (e) {
      // Covers the broken-binary case on this Mac: a clear, non-retriable card.
      return errorSnapshot('codex', 'Codex', e, 'unofficial');
    }
  },
};
