// ccusage token/cost ESTIMATOR — UNOFFICIAL / best-effort. Architecture §6
// (local/ccusage), §12 (reuse ccusage as a subprocess), Story 3.3.
//
// Runs `npx ccusage … --json` as a subprocess. ccusage reconstructs token counts
// and estimated cost from local `~/.claude/**/*.jsonl` logs — entirely offline. It
// does NOT know real remaining quota, so the card is labeled an ESTIMATE, not a
// live gauge (confidence:"unofficial", freshness:"historical"). No web scraping;
// local JSONL only (NFR7). A missing/failing ccusage degrades to an error card and
// affects nothing else (fail-soft).

import { execFile } from 'node:child_process';
import { errorSnapshot, ProviderError } from '../../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../../core/types.js';

/** The subset of `ccusage … --json` we consume (tolerant of minor shape drift). */
export interface CcusageJson {
  totals?: {
    totalCost?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  daily?: Array<{ totalTokens?: number; totalCost?: number }>;
}

function sumTokens(t: NonNullable<CcusageJson['totals']>): number {
  if (typeof t.totalTokens === 'number') return t.totalTokens;
  return (
    (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheCreationTokens ?? 0) + (t.cacheReadTokens ?? 0)
  );
}

/**
 * Pure mapping: ccusage JSON → tokens + spend ESTIMATE meters. No subprocess.
 * Exported for fixture tests. Labels make clear this is an estimate.
 */
export function mapCcusage(data: CcusageJson, fetchedAt = new Date().toISOString()): ProviderSnapshot {
  const totals =
    data.totals ??
    (data.daily
      ? {
          totalTokens: data.daily.reduce((s, d) => s + (d.totalTokens ?? 0), 0),
          totalCost: data.daily.reduce((s, d) => s + (d.totalCost ?? 0), 0),
        }
      : undefined);

  if (!totals) {
    return errorSnapshot(
      'ccusage',
      'ccusage (estimate)',
      new ProviderError('ccusage returned no totals (output shape changed)', { retriable: false }),
      'unofficial',
    );
  }

  const meters: Meter[] = [];
  const tokens = sumTokens(totals);
  meters.push({ kind: 'tokens', label: 'Tokens (est.)', value: Math.round(tokens), unit: 'tokens' });
  if (typeof totals.totalCost === 'number') {
    meters.push({ kind: 'spend', label: 'Cost (est.)', value: round(totals.totalCost), unit: 'usd' });
  }

  return {
    providerId: 'ccusage',
    displayName: 'ccusage (estimate)',
    meters,
    confidence: 'unofficial',
    freshness: 'historical', // reconstructed from logs, not a live quota
    fetchedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Spawn `npx ccusage … --json`. Rejects (fail-soft up the stack) if absent/broken. */
function runCcusage(timeoutMs = 15000): Promise<CcusageJson> {
  return new Promise((resolve, reject) => {
    const cmd = process.env.CCUSAGE_CMD || 'npx';
    const args = process.env.CCUSAGE_CMD ? ['--json'] : ['ccusage@latest', 'daily', '--json'];
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new ProviderError('ccusage/npx not available — install Node/npx to enable the estimate', { retriable: false }));
      }
      if (err && !stdout) {
        return reject(new ProviderError(`ccusage failed: ${err.message}`, { retriable: true }));
      }
      const json = extractJson(stdout ?? '');
      if (!json) return reject(new ProviderError('ccusage returned no parseable JSON', { retriable: false }));
      resolve(json);
    });
  });
}

/** Pull the first JSON object out of ccusage stdout (it may print a banner first). */
export function extractJson(stdout: string): CcusageJson | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as CcusageJson;
  } catch {
    return null;
  }
}

export const ccusage: UsageProvider = {
  id: 'ccusage',
  displayName: 'ccusage (estimate)',
  confidence: 'unofficial',
  cacheTtlSeconds: 900, // 15 min — subprocess is comparatively expensive
  async fetch(_creds: ProviderCredentials): Promise<ProviderSnapshot> {
    try {
      // Test/dev injection: skip the subprocess entirely if a payload is provided.
      if (process.env.CCUSAGE_JSON) {
        return mapCcusage(JSON.parse(process.env.CCUSAGE_JSON) as CcusageJson);
      }
      const data = await runCcusage();
      return mapCcusage(data);
    } catch (e) {
      return errorSnapshot('ccusage', 'ccusage (estimate)', e, 'unofficial');
    }
  },
};
