// Config + secret loading. Architecture §9 (secret model), Story 1.6.
//
// Load order (first hit wins per variable, all in-memory — plaintext is NEVER
// written to disk by this process):
//   1. process.env                        (launchd / shell)
//   2. .env.age  (decrypted via scripts/vault.sh, if age + identity present)
//   3. .env      (dotenv, gitignored — dev convenience)
//
// The decrypted vault is parsed into memory and mapped to per-provider
// ProviderCredentials handed ONLY to adapters. No secret is logged (redaction) and
// none is placed in a ProviderSnapshot (§4 invariant).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from './core/normalize.js';
import type { ProviderCredentials } from './core/types.js';

export type AuthMode = 'password' | 'open' | 'closed';

export interface AppConfig {
  host: string;
  port: number;
  cachePath: string;
  authMode: AuthMode;
  dashboardPassword?: string;
  /**
   * Allowed browser Origins for Topology B (Vercel/CF UI → Mac collector).
   * Empty = same-origin only (no CORS headers). Exact match, no wildcards.
   */
  corsOrigins: string[];
  /** Raw resolved env map (already merged) — kept private to config. */
  env: Record<string, string>;
}

export interface LoadedConfig extends AppConfig {
  /** Credentials for one provider id. Returns {} when nothing is configured. */
  credentialsFor(providerId: string): ProviderCredentials;
  /** True when at least one non-empty credential value exists for the provider. */
  hasCredentials(providerId: string): boolean;
}

const ROOT = resolve(process.cwd());

/** Parse a dotenv-style file body into a flat map. Ignores comments/blank lines. */
export function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Decrypt .env.age to plaintext ON STDOUT via scripts/vault.sh, without writing
 * plaintext to disk. Graceful: returns null if the vault or age is unavailable.
 */
function decryptVault(log: (m: string) => void): Record<string, string> | null {
  const vaultFile = resolve(ROOT, '.env.age');
  if (!existsSync(vaultFile)) return null;
  const script = resolve(ROOT, 'scripts/vault.sh');
  if (!existsSync(script)) return null;
  try {
    const stdout = execFileSync('sh', [script, 'decrypt', vaultFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log('vault: decrypted .env.age into memory');
    return parseEnv(stdout);
  } catch (e) {
    // age missing, wrong identity, etc. Fall back to .env / process.env.
    log(`vault: could not decrypt .env.age (${redact(e instanceof Error ? e.message : String(e))}); falling back`);
    return null;
  }
}

function readDotenv(): Record<string, string> {
  const dotenv = resolve(ROOT, '.env');
  if (!existsSync(dotenv)) return {};
  try {
    return parseEnv(readFileSync(dotenv, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(log: (m: string) => void = () => {}): LoadedConfig {
  // Precedence: process.env > vault > .env
  const merged: Record<string, string> = {};
  const dotenv = readDotenv();
  const vault = decryptVault(log) ?? {};
  for (const [k, v] of Object.entries(dotenv)) merged[k] = v;
  for (const [k, v] of Object.entries(vault)) merged[k] = v;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;

  const dashboardPassword = merged.DASHBOARD_PASSWORD?.trim() || undefined;
  const rawAuthMode = (merged.AUTH_MODE?.trim().toLowerCase() as AuthMode | undefined) ?? undefined;
  const authMode: AuthMode = resolveAuthMode(rawAuthMode, dashboardPassword);

  const cfg: AppConfig = {
    host: merged.HOST?.trim() || '127.0.0.1',
    port: Number.parseInt(merged.PORT ?? '', 10) || 8787,
    cachePath: merged.CACHE_PATH?.trim() || '.data/cache.json',
    authMode,
    dashboardPassword,
    corsOrigins: parseCorsOrigins(merged.CORS_ORIGINS),
    env: merged,
  };

  return {
    ...cfg,
    credentialsFor(providerId: string): ProviderCredentials {
      return credentialMap(merged)[providerId] ?? {};
    },
    hasCredentials(providerId: string): boolean {
      const creds = credentialMap(merged)[providerId] ?? {};
      return Object.values(creds).some((v) => typeof v === 'string' && v.trim() !== '');
    },
  };
}

function resolveAuthMode(raw: AuthMode | undefined, password: string | undefined): AuthMode {
  if (raw === 'open') return 'open';
  if (password) return 'password';
  // No password and not explicitly open → closed (reject) by default. The network
  // (Tailscale Topology A) is the real gate; a stray open port must not serve data.
  return 'closed';
}

/** Comma/space-separated Origin list for CORS (Topology B). Trailing slashes stripped. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const o = part.trim().replace(/\/+$/, '');
    if (!o) continue;
    try {
      const u = new URL(o);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      // Origin only (scheme + host + port) — path is not part of Origin.
      out.push(u.origin);
    } catch {
      // skip malformed
    }
  }
  return [...new Set(out)];
}

/**
 * Map merged env → per-provider credentials. Adding a provider is one entry here.
 * Local readers (claude-code/codex/ccusage/grok) take no vault key by
 * default — they self-discover local credentials at fetch time
 * (src/providers/local/*). Optional env overrides still flow through here.
 */
function credentialMap(env: Record<string, string>): Record<string, ProviderCredentials> {
  return {
    openrouter: { OPENROUTER_KEY: env.OPENROUTER_KEY },
    // Epic 2 (official APIs) — opt-in: the registry only registers these when the
    // relevant key is present (see registry.ts / providerKeyEnv).
    openai: { OPENAI_ADMIN_KEY: env.OPENAI_ADMIN_KEY },
    anthropic: { ANTHROPIC_ADMIN_KEY: env.ANTHROPIC_ADMIN_KEY },
    deepseek: { DEEPSEEK_KEY: env.DEEPSEEK_KEY },
    xai: { XAI_MANAGEMENT_KEY: env.XAI_MANAGEMENT_KEY },
    // BytePlus ModelArk Coding Plan — account API access key (AK/SK) that signs the
    // GetCodingPlanUsage OpenAPI action (Volcengine sig v4). NOT the ARK inference key.
    byteplus: {
      BYTEPLUS_ACCESS_KEY: env.BYTEPLUS_ACCESS_KEY,
      BYTEPLUS_SECRET_KEY: env.BYTEPLUS_SECRET_KEY,
      BYTEPLUS_REGION: env.BYTEPLUS_REGION,
    },
  };
}
