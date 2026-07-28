# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
**private vulnerability reporting** (the *Report a vulnerability* button under the
repository's *Security* tab), or open a minimal issue asking for a private contact
channel. You'll get an acknowledgement as soon as possible.

## Design invariants

This project is built around a few security invariants — a report that shows any
of these is broken is always in scope:

- **`GET /api/snapshot` is key-free.** It returns only normalized
  `ProviderSnapshot[]`; no provider key, token, or raw credential ever appears in
  a response or reaches the browser / static host.
- **Credentials stay on the collector machine.** They come from the environment, a
  gitignored `.env`, or an age-encrypted `.env.age` vault — never committed, never
  serialized into a snapshot.
- **`/api/health` exposes liveness only** (no usage values, no secrets).

## Running it safely

- Never commit real keys. `.env`, `.env.local`, `.env.age`'s identity, and the
  `.data/` cache are gitignored; `npm run secret-scan` (also enforced in CI)
  rejects accidentally-committed key material.
- The recommended deployment gates the collector behind Tailscale (network-as-gate)
  and/or a `DASHBOARD_PASSWORD`. `AUTH_MODE=open` is for loopback development only.

## Unofficial readers & provider Terms of Service

The `unofficial` providers (Claude Code, Codex, Grok, ccusage) read **undocumented
endpoints or the local credential files the vendor CLIs already wrote on your
machine**. They perform no web scraping and only read your own local data, but the
endpoints are undocumented and may change or be restricted at any time. **Enabling
them is your responsibility under each provider's Terms of Service.** Every such
card is labelled `unofficial`; use only the official adapters if you want a
fully-sanctioned board.
