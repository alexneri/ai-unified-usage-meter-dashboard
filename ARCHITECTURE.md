# Architecture

The system is deliberately split in two so that **credentials and provider calls
live on exactly one trusted machine**, and everything shown to a browser is
key-free.

```
   Providers (OpenAI, Anthropic, OpenRouter, xAI, DeepSeek, BytePlus, …)
        ▲ official APIs            ▲ local CLI tokens (Claude Code, Codex, Grok, ccusage)
        │                          │
  ┌─────┴──────────────────────────┴─────┐   TRUSTED (holds every secret)
  │            Collector (Hono)           │
  │  scheduler → adapters → normalize →   │
  │  JsonFileCache ─────────────► /api/snapshot (key-free)
  └───────────────────────────────┬───────┘
                                  │  GET /api/snapshot  (ProviderSnapshot[], no keys)
                            ┌─────▼─────┐   DUMB DISPLAY
                            │  Web UI   │   one card per provider
                            └───────────┘
```

## Collector pipeline

`src/index.ts` wires it up (load config → register adapters → start scheduler →
serve). The request path does **no** provider I/O:

- **`PollingScheduler`** (`src/core/scheduler.ts`) polls each registered adapter
  on an interval, staggered, and writes results to the cache. A slow or failing
  provider never blocks another.
- **`JsonFileCache`** (`src/core/cache.ts`) persists the last-good snapshot per
  provider, so a restart repaints immediately and a transient provider outage
  degrades to a `stale` card rather than a blank one.
- **`GET /api/snapshot`** is a read-through from the cache — it returns
  `ProviderSnapshot[]` and never triggers a provider call or exposes a key.
- **`GET /api/health`** reports liveness only (no usage values, no secrets) and
  stays unauthenticated.

## The `UsageProvider` adapter interface

Adding a provider is **one file plus one registry entry** — no core change.

```ts
interface UsageProvider {
  id: string;
  displayName: string;
  confidence: 'official' | 'unofficial';
  fetch(creds: ProviderCredentials): Promise<ProviderSnapshot>;
}
```

Each adapter maps a raw provider response into the normalized snapshot:

```ts
interface ProviderSnapshot {
  providerId: string;
  displayName: string;
  confidence: 'official' | 'unofficial';
  freshness: 'live' | 'historical' | 'stale';
  meters: Meter[];
  sparkline?: Series;
  error?: { message: string; retriable: boolean };
  fetchedAt: string; // ISO
}

interface Meter {
  kind: 'quota' | 'balance' | 'spend' | 'rate_limit';
  label: string;
  unit: 'usd' | 'tokens' | 'requests' | 'percent';
  value: number;
  limit?: number;
  remaining?: number;
  resetsAt?: string;      // ISO
  windowSeconds?: number;
}
```

Because every provider is reduced to the same `Meter` vocabulary, the UI ranks and
renders them uniformly (e.g. "% of cap used" drives which card becomes the hero).

## Registration model (`src/providers/registry.ts`)

- **Always-on:** OpenRouter (the anchor) plus the self-discovering local readers
  (Claude Code, Codex, ccusage, Grok). They render an honest fail-soft error card
  when their local source is missing, rather than crashing.
- **Opt-in official APIs** (OpenAI, Anthropic, DeepSeek, xAI, BytePlus) register
  **only when their credential is present**, so the board shows nothing for a
  service you don't use.

## Confidence & honesty

`official` = a documented provider API. `unofficial` = a best-effort local reader
of an undocumented endpoint or local CLI token — it may break, and every such card
says so. This is the core design value: a dashboard that is *honest about how much
to trust each number*, never silently wrong.

## Auth boundary

`src/auth.ts` gates the UI + `/api/snapshot`; `/api/health` and static assets stay
open. Three modes:

- **network-as-gate** (recommended): run behind Tailscale so only your devices
  reach the collector;
- **password**: `DASHBOARD_PASSWORD` → an HMAC-signed, restart-safe session cookie
  (and a `Bearer` path for the cross-origin static UI);
- **open**: loopback dev only, logs a warning.

See [`deploy/README.md`](./deploy/README.md) for Topology A (collector serves the
UI over the tailnet) vs Topology B (static UI on Vercel/CF fetching the key-free
snapshot from the Mac).

## Secret handling

Credentials come from `process.env`, a local `.env` (gitignored), or an
[age](https://age-encryption.org)-encrypted `.env.age` vault decrypted at boot
(`scripts/vault.sh`). They are **never** written into a snapshot and never reach
the browser. `scripts/secret-scan.sh` (run in CI) rejects accidentally-committed
key material.
