// Local Claude Code quota reader — UNOFFICIAL / best-effort. Architecture §6
// (local/claude-code), Story 3.1.
//
// Shows the Claude 5-hour + 7-day usage windows (shared across Claude.ai, Claude
// Code and Cowork) without opening the TUI. Two local-only sources, in priority:
//
//   1. STDIN snapshot (preferred, zero API calls): the `rate_limits.{five_hour,
//      seven_day}` object Claude Code hands to statusline scripts. A statusline
//      hook can capture it to a file / env var; we read it via
//      CLAUDE_CODE_RATE_LIMITS_JSON (inline JSON) or CLAUDE_CODE_RATE_LIMITS_FILE.
//
//   2. OAuth usage endpoint (fallback): the undocumented
//      `GET https://api.anthropic.com/api/oauth/usage` with the LOCAL Claude Code
//      OAuth token (macOS Keychain) + `anthropic-beta: oauth-2025-04-20`.
//
// NEVER scrapes claude.ai (Consumer-ToS; NFR7). The OAuth token is read from the
// keychain, used for one request, and dropped — it never enters the snapshot.
// Numbers are approximate/windowed and the undocumented endpoint may break, so the
// card is confidence:"unofficial" (best-effort chip + "may break").

import { existsSync, readFileSync } from 'node:fs';
import { ProviderError, errorSnapshot } from '../../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../../core/types.js';
import { readClaudeOAuth } from './credentials.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;

/** One usage window as reported by either source (fields are tolerated variants). */
export interface UsageWindow {
  utilization?: number; // percent used (0–100) — OAuth endpoint
  used_percent?: number; // percent used (0–100) — statusline stdin variant
  resets_at?: string; // ISO
  resetsAt?: string; // ISO (camelCase variant)
}

/** The subset of the OAuth usage / stdin rate_limits payload we consume. */
export interface ClaudeUsage {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
}

function pctUsed(w: UsageWindow | null | undefined): number | null {
  if (!w) return null;
  const v = typeof w.utilization === 'number' ? w.utilization : w.used_percent;
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return v;
}

function resetIso(w: UsageWindow | null | undefined): string | undefined {
  return w?.resets_at ?? w?.resetsAt ?? undefined;
}

function windowMeter(label: string, w: UsageWindow | null | undefined, windowSeconds: number): Meter | null {
  const used = pctUsed(w);
  if (used === null) return null;
  const clamped = Math.max(0, Math.min(100, round(used)));
  return {
    kind: 'quota',
    label,
    value: clamped, // percent USED
    unit: 'percent',
    limit: 100,
    remaining: round(100 - clamped), // percent LEFT (drives the meter bar)
    resetsAt: resetIso(w),
    windowSeconds,
  };
}

/**
 * Pure mapping: usage windows → 5h + 7d quota meters. No network, no secrets.
 * Exported so unit tests assert fixture → meters without a live call or keychain.
 */
export function mapClaudeUsage(usage: ClaudeUsage, fetchedAt = new Date().toISOString()): ProviderSnapshot {
  const meters: Meter[] = [];
  const five = windowMeter('5-hour window', usage.five_hour, FIVE_HOURS);
  const seven = windowMeter('7-day window', usage.seven_day, SEVEN_DAYS);
  if (five) meters.push(five);
  if (seven) meters.push(seven);

  if (meters.length === 0) {
    // Both windows absent → treat as a drifted/empty source, not a silent success.
    return errorSnapshot(
      'claude-code',
      'Claude Code',
      new ProviderError('Claude usage response had no recognizable windows (unofficial endpoint changed)', {
        retriable: false,
      }),
      'unofficial',
    );
  }

  return {
    providerId: 'claude-code',
    displayName: 'Claude Code',
    meters,
    confidence: 'unofficial',
    freshness: 'live',
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read a statusline-captured snapshot from env/file, if the hook provided one. */
function readInjectedSnapshot(env: NodeJS.ProcessEnv): ClaudeUsage | null {
  const inline = env.CLAUDE_CODE_RATE_LIMITS_JSON;
  const raw = inline ?? readFileMaybe(env.CLAUDE_CODE_RATE_LIMITS_FILE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClaudeUsage & { rate_limits?: ClaudeUsage };
    // Statusline passes the whole stdin object; accept a nested rate_limits too.
    return parsed.rate_limits ?? parsed;
  } catch {
    return null;
  }
}

function readFileMaybe(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

async function fetchOAuthUsage(token: string): Promise<ClaudeUsage> {
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    });
  } catch (e) {
    throw new ProviderError(`network error reading Claude usage: ${e instanceof Error ? e.message : e}`, {
      retriable: true,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('Claude local token was rejected (401/403) — re-login to Claude Code', {
      retriable: false,
      status: res.status,
    });
  }
  // 429 is a transient quota on the *usage endpoint itself* (not Claude's model
  // windows). Treat as retriable so the scheduler can keep last-good meters.
  if (res.status === 429) {
    throw new ProviderError('Claude usage endpoint rate-limited (429) — will retry', {
      retriable: true,
      status: 429,
    });
  }
  if (res.status >= 500) {
    throw new ProviderError(`Anthropic server error (${res.status})`, { retriable: true, status: res.status });
  }
  if (!res.ok) {
    throw new ProviderError(`Claude usage request failed (${res.status})`, { retriable: false, status: res.status });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError('Claude usage returned a non-JSON response (unofficial endpoint changed)', {
      retriable: false,
    });
  }
  if (!body || typeof body !== 'object') {
    throw new ProviderError('Claude usage returned an unexpected response shape', { retriable: false });
  }
  return body as ClaudeUsage;
}

export const claudeCode: UsageProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  confidence: 'unofficial',
  // 15 min — the OAuth usage endpoint rate-limits under frequent polls (HTTP 429).
  // Quotas themselves move on a 5h/7d scale, so a longer TTL is honest and safer.
  cacheTtlSeconds: 900,
  async fetch(_creds: ProviderCredentials): Promise<ProviderSnapshot> {
    try {
      // 1) Preferred: statusline-captured snapshot (zero API calls).
      const injected = readInjectedSnapshot(process.env);
      if (injected) return mapClaudeUsage(injected);

      // 2) Fallback: undocumented OAuth usage endpoint with the local token.
      const oauth = readClaudeOAuth();
      if (!oauth?.accessToken) {
        return errorSnapshot(
          'claude-code',
          'Claude Code',
          new ProviderError(
            'No local Claude Code login found — sign in to Claude Code (keychain "Claude Code-credentials") or set CLAUDE_CODE_RATE_LIMITS_JSON',
            { retriable: false },
          ),
          'unofficial',
        );
      }
      const usage = await fetchOAuthUsage(oauth.accessToken);
      return mapClaudeUsage(usage);
    } catch (e) {
      return errorSnapshot('claude-code', 'Claude Code', e, 'unofficial');
    }
  },
};
