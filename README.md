# AI Unified Usage Meter Dashboard

One honest board for **AI spend and usage limits across every provider you use** —
official org bills and credit balances alongside best-effort consumer quota bars
(Claude Code, Codex, Grok) — collected on a machine you trust and shown on a
key-free web UI.

It answers two questions at a glance: *how much have I spent across everything*
and *how close am I to a limit right now.*

<!-- Add a screenshot here: docs/screenshot.png -->

## Why it's built in two halves

A **collector** (TypeScript / [Hono](https://hono.dev)) runs on a machine you
control. It is the *only* component that holds a credential or talks to a
provider. A **web UI** is a dumb display of the collector's key-free
`GET /api/snapshot` — one card per provider, each carrying:

- a **confidence** chip — `official` (documented provider API) vs
  `unofficial` (best-effort local reader that may break), and
- a **freshness** badge (`live` / `historical` / `stale`),

so the board is *honest* rather than silently wrong. No provider key ever reaches
the browser or the static host.

This is a **personal, single-user utility** — not a multi-tenant SaaS.

## Providers

| Provider | Kind | What it reads |
|---|---|---|
| OpenRouter | official | credit balance + key limit |
| OpenAI (org) | official, opt-in | org cost + usage (Admin key) |
| Anthropic (org) | official, opt-in | org cost + usage (Admin key) |
| DeepSeek | official, opt-in | account balance |
| xAI | official, opt-in | management-API billing (not consumer Grok) |
| BytePlus ModelArk | official, opt-in | Coding Plan quota (AK/SK) |
| Claude Code | **unofficial** | local 5h/7d usage windows |
| Codex / ChatGPT | **unofficial** | local 5h/weekly windows |
| ccusage | **unofficial** | token/cost estimate from local `~/.claude` logs |
| Grok CLI | **unofficial** | the CLI's own local billing endpoint |

Official adapters are **opt-in**: each registers only when its key is present, so
the board shows only the services you actually use. The unofficial local readers
self-discover the tokens the vendor CLIs already stored on your machine.

> ⚠️ **Unofficial readers.** These call **undocumented** endpoints (or read local
> credential files the vendor CLIs wrote) and can break whenever a provider
> changes something. They do **no** web scraping — only your own local data — but
> using them is **your responsibility under each provider's Terms of Service**.
> Every unofficial card is clearly labelled `unofficial`. Set only the official
> keys if you want a fully-sanctioned board.

## Quick start (local)

Requires Node ≥ 20.

```sh
git clone https://github.com/<you>/ai-unified-usage-meter-dashboard
cd ai-unified-usage-meter-dashboard
npm install
cp .env.example .env          # add the provider keys you have; all are optional
AUTH_MODE=open npm start      # dev only: serves UI + API on http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787>. With no keys you'll still see the local consumer
readers (if their CLIs are logged in) plus a "not configured" OpenRouter card
inviting a key. `AUTH_MODE=open` is loopback-dev only — see auth below.

Scripts:

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run secret-scan # reject accidentally-committed key material
npm run build:web   # static UI bundle for Vercel/CF (Topology B)
```

## Auth & deployment

- **Default gate is the network.** The recommended model runs the collector
  behind [Tailscale](https://tailscale.com) so only your own devices reach it.
- **Optional password.** Set `DASHBOARD_PASSWORD` for a session/Bearer gate on the
  UI + `/api/snapshot` (`/api/health` stays open). `AUTH_MODE=open` is for
  loopback dev only and logs a warning.
- **Two topologies** — collector-serves-UI, or a static UI (Vercel/CF) that
  fetches the key-free snapshot from the collector over Tailscale. See
  [`deploy/README.md`](./deploy/README.md).

Secrets live in a local `.env` (gitignored) or an [age](https://age-encryption.org)
vault (`.env.age`, see `scripts/vault.sh`). **Never commit real keys** — the
`secret-scan` gate and CI guard against it.

## How it fits together

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the collector pipeline, the
`UsageProvider` adapter interface (a new provider is one file + one registry
entry), and the key-free snapshot contract. Security policy:
[`SECURITY.md`](./SECURITY.md). Contributions: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
