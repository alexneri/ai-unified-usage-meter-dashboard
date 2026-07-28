// BytePlus ModelArk Coding Plan usage adapter — official, live. Architecture §6.
//
// The Coding Plan meters usage in three rolling windows (5-hour "session", 7-day,
// 30-day), each reported as percent-used with a reset time — the same shape as the
// Claude Code / Codex readers. There is NO usage signal on the inference host
// (ark.*.bytepluses.com returns per-request tokens only — no quota headers, no usage
// endpoint), so the plan quota is read from the account OpenAPI action instead:
//
//   GET https://open.byteplusapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01
//     signed with Volcengine signature v4 (service "ark", region ap-southeast-1),
//     using the ACCOUNT API access key (AK/SK) — NOT the ARK inference bearer key.
//   → Result.QuotaUsage: [{ Level: 'session'|'weekly'|'monthly', Percent, ResetTimestamp }]
//
// Opt-in: registered only when BYTEPLUS_ACCESS_KEY + BYTEPLUS_SECRET_KEY are present.
// The AK/SK sign the request and NEVER enter the snapshot (§4 invariant).

import { createHash, createHmac } from 'node:crypto';
import { ProviderError, errorSnapshot } from '../core/normalize.js';
import type { Meter, ProviderCredentials, ProviderSnapshot, UsageProvider } from '../core/types.js';

const HOST = 'open.byteplusapi.com';
const SERVICE = 'ark';
const ACTION = 'GetCodingPlanUsage';
const VERSION = '2024-01-01';
const DEFAULT_REGION = 'ap-southeast-1';

/** Window metadata by BytePlus quota Level — display label + nominal length. */
const WINDOWS: Record<string, { label: string; seconds: number }> = {
  session: { label: 'Session (5h)', seconds: 5 * 3600 },
  weekly: { label: 'Weekly (7d)', seconds: 7 * 86400 },
  monthly: { label: 'Monthly (30d)', seconds: 30 * 86400 },
};
const ORDER = ['session', 'weekly', 'monthly'] as const;

/** One row of Result.QuotaUsage (fields tolerated as optional for drift-safety). */
export interface ByteplusQuota {
  Level?: string;
  Percent?: number; // percent USED, 0–100
  ResetTimestamp?: number; // unix seconds
}

/** The GetCodingPlanUsage response envelope (Volcengine/BytePlus OpenAPI shape). */
export interface ByteplusUsageResponse {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: { Status?: string; UpdateTimestamp?: number; QuotaUsage?: ByteplusQuota[] };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One quota window → a percent-used meter (mirrors the Claude Code windows). */
function windowMeter(row: ByteplusQuota): Meter | null {
  const meta = WINDOWS[row.Level ?? ''];
  if (!meta || typeof row.Percent !== 'number' || Number.isNaN(row.Percent)) return null;
  const usedPct = Math.max(0, Math.min(100, round(row.Percent)));
  return {
    kind: 'quota',
    label: meta.label,
    value: usedPct, // percent USED
    unit: 'percent',
    limit: 100,
    remaining: round(100 - usedPct), // percent LEFT (drives the meter bar)
    resetsAt: typeof row.ResetTimestamp === 'number' ? new Date(row.ResetTimestamp * 1000).toISOString() : undefined,
    windowSeconds: meta.seconds,
  };
}

/**
 * Pure mapping: GetCodingPlanUsage Result → 5h/7d/30d quota meters. No network, no
 * secrets. Exported so unit tests assert fixture → meters without a live signed call.
 */
export function mapByteplusSnapshot(
  data: ByteplusUsageResponse,
  fetchedAt = new Date().toISOString(),
): ProviderSnapshot {
  const rows = new Map((data.Result?.QuotaUsage ?? []).map((r) => [r.Level ?? '', r]));
  const meters: Meter[] = [];
  for (const level of ORDER) {
    const m = windowMeter(rows.get(level) ?? { Level: level });
    if (m) meters.push(m);
  }
  if (meters.length === 0) {
    return errorSnapshot(
      'byteplus',
      'BytePlus',
      new ProviderError('BytePlus returned no recognizable quota windows (unexpected response shape)', {
        retriable: false,
      }),
    );
  }
  return {
    providerId: 'byteplus',
    displayName: 'BytePlus',
    meters,
    confidence: 'official',
    freshness: 'live',
    fetchedAt,
  };
}

/**
 * Volcengine signature v4 for an empty-body GET (SignedHeaders = x-date). Returns the
 * headers to attach. Mirrors the @volcengine/openapi signer; kept inline to avoid a
 * heavy SDK dependency for a single call.
 */
function signHeaders(accessKey: string, secretKey: string, region: string, query: string): Record<string, string> {
  const xDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, ''); // YYYYMMDDTHHMMSSZ
  const shortDate = xDate.slice(0, 8);
  const payloadHash = createHash('sha256').update('').digest('hex');
  const canonicalRequest = ['GET', '/', query, `x-date:${xDate}\n`, 'x-date', payloadHash].join('\n');
  const scope = `${shortDate}/${region}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join(
    '\n',
  );
  const hmac = (key: Buffer | string, msg: string): Buffer => createHmac('sha256', key).update(msg).digest();
  const signingKey = hmac(hmac(hmac(hmac(secretKey, shortDate), region), SERVICE), 'request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    'X-Date': xDate,
    Authorization: `HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=x-date, Signature=${signature}`,
  };
}

export const byteplus: UsageProvider = {
  id: 'byteplus',
  displayName: 'BytePlus',
  confidence: 'official',
  cacheTtlSeconds: 300, // live windowed quota; 5 min is plenty
  async fetch(creds: ProviderCredentials): Promise<ProviderSnapshot> {
    const accessKey = creds.BYTEPLUS_ACCESS_KEY;
    const secretKey = creds.BYTEPLUS_SECRET_KEY;
    const region = creds.BYTEPLUS_REGION?.trim() || DEFAULT_REGION;
    if (!accessKey || !secretKey) {
      return errorSnapshot(
        'byteplus',
        'BytePlus',
        new ProviderError(
          'BytePlus is not configured — set BYTEPLUS_ACCESS_KEY + BYTEPLUS_SECRET_KEY (account API access key with ark access) in the vault',
          { retriable: false },
        ),
      );
    }
    const query = `Action=${ACTION}&Version=${VERSION}`;
    const url = `https://${HOST}/?${query}`;
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { ...signHeaders(accessKey, secretKey, region, query), Host: HOST, Accept: 'application/json' },
        });
      } catch (e) {
        throw new ProviderError(`network error calling BytePlus: ${e instanceof Error ? e.message : e}`, {
          retriable: true,
        });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          'BytePlus auth failed (401/403) — check BYTEPLUS_ACCESS_KEY/SECRET_KEY (account AK/SK with ark access)',
          { retriable: false, status: res.status },
        );
      }
      if (res.status >= 500) {
        throw new ProviderError(`BytePlus server error (${res.status})`, { retriable: true, status: res.status });
      }
      if (!res.ok) throw new ProviderError(`BytePlus request failed (${res.status})`, { retriable: false, status: res.status });
      let body: ByteplusUsageResponse;
      try {
        body = (await res.json()) as ByteplusUsageResponse;
      } catch {
        throw new ProviderError('BytePlus returned an unexpected (non-JSON) response', { retriable: false });
      }
      const apiErr = body.ResponseMetadata?.Error;
      if (apiErr?.Code) {
        throw new ProviderError(`BytePlus API error: ${apiErr.Code}${apiErr.Message ? ` — ${apiErr.Message}` : ''}`, {
          retriable: false,
        });
      }
      return mapByteplusSnapshot(body);
    } catch (e) {
      return errorSnapshot('byteplus', 'BytePlus', e);
    }
  },
};
