// Local credential discovery for the unofficial consumer readers (Epic 3).
//
// These helpers let the collector self-discover the machine's *local* OAuth tokens
// so an empty vault still yields useful cards for the services Alex already uses
// (Claude Code, Codex, Grok CLI). They read only local, sanctioned stores:
//   - macOS Keychain item `Claude Code-credentials` (claudeAiOauth.accessToken)
//   - ~/.codex/auth.json    (ChatGPT/Codex OAuth tokens)
//   - ~/.grok/auth.json     (Grok CLI OIDC profile)
//
// HARD RULES (Architecture §4/§9, NFR3/NFR7):
//   - Secrets are read, used for a request, and dropped. They NEVER enter a
//     ProviderSnapshot and are NEVER logged (all log paths go through redact()).
//   - No web scraping — local files / keychain only.
//   - Everything is best-effort: a missing store returns null, never throws.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** Expand a leading ~ to the user's home dir. */
function home(...parts: string[]): string {
  return join(homedir(), ...parts);
}

/** Read a whole file as JSON, or null if missing/unreadable/not-JSON. Never throws. */
function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

// --- Claude Code (macOS Keychain) ------------------------------------------

export interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * Read the Claude Code OAuth access token from the macOS login keychain.
 *
 * Claude Code stores the live credential under generic-password service
 * `Claude Code-credentials` as JSON `{ claudeAiOauth: { accessToken, ... } }`.
 * `security find-generic-password -w` prints only the secret value to stdout; we
 * parse it in-memory and never echo it. Returns null off macOS or when the item
 * is absent / access is denied (fail-soft — the card degrades to an error state).
 *
 * `service` is injectable for tests so CI never touches a real keychain.
 */
export function readClaudeOAuth(
  service = 'Claude Code-credentials',
  platform = process.platform,
): ClaudeOAuth | null {
  // A file-based token wins when present (Linux/CI/containers, or a future change
  // in where Claude Code persists creds). Checked first so it's overridable.
  const fileToken = readJson<{ claudeAiOauth?: ClaudeOAuth }>(home('.claude', '.credentials.json'));
  if (fileToken?.claudeAiOauth?.accessToken) return fileToken.claudeAiOauth;

  if (platform !== 'darwin') return null;
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // swallow the "item not found" stderr
    });
    const parsed = JSON.parse(raw) as { claudeAiOauth?: ClaudeOAuth };
    const oauth = parsed.claudeAiOauth;
    if (oauth?.accessToken) return oauth;
    return null;
  } catch {
    // Item missing, keychain locked, or user denied access → fail-soft.
    return null;
  }
}

// --- Codex / ChatGPT (~/.codex/auth.json) ----------------------------------

export interface CodexAuth {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/** Read ~/.codex/auth.json (ChatGPT/Codex login). null when the CLI isn't logged in. */
export function readCodexAuth(path = home('.codex', 'auth.json')): CodexAuth | null {
  return readJson<CodexAuth>(path);
}

// --- Grok CLI (~/.grok/auth.json) ------------------------------------------

export interface GrokProfile {
  key?: string;
  refresh_token?: string;
  team_id?: string;
  user_id?: string;
  email?: string;
  expires_at?: number | string;
  oidc_issuer?: string;
}

/**
 * Read the Grok CLI OIDC profile from ~/.grok/auth.json. The file is keyed by an
 * `<issuer>::<uuid>` string; we return the first profile. null when not logged in.
 */
export function readGrokProfile(path = home('.grok', 'auth.json')): GrokProfile | null {
  const doc = readJson<Record<string, GrokProfile>>(path);
  if (!doc || typeof doc !== 'object') return null;
  const first = Object.values(doc).find((v) => v && typeof v === 'object');
  return first ?? null;
}

/** The machine name, for honest card copy ("read locally on <host>"). */
export function machineName(): string {
  try {
    return hostname();
  } catch {
    return 'this machine';
  }
}
