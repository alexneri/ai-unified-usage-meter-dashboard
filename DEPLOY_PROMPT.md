# Deploy Prompt — AI Unified Usage Meter Dashboard

A copy-paste deployment playbook for an AI coding agent. Either paste everything
below the line into **Cursor** or **Claude Code**, or just tell your agent:
*"Read `DEPLOY_PROMPT.md` and deploy this repo."*

---

You are helping me deploy the **AI Unified Usage Meter Dashboard** on my machine.

It is two parts: a local **collector** (Hono / TypeScript) that holds every
credential and polls providers, and a **key-free web UI** that only displays the
collector's `GET /api/snapshot`. Work through the phases below in order.

**Ground rules**
- Prefer safe, reversible steps. **Show me each command before running anything
  that writes outside the repo** (launchd, Tailscale, Vercel, `git push`).
- **Never invent or commit a credential.** If I don't have a key, skip that
  provider — a missing provider is simply omitted, not an error.
- Keep every provider key on the collector. The UI and any static host stay
  key-free. Don't weaken auth to "make it work".
- At each decision point (auth, topology), **ask me** rather than guessing.

## Phase 0 — Preflight
- `node -v` → must be ≥ 20.
- Confirm repo root: `package.json` name is `ai-unified-usage-meter-dashboard`.
- `npm install`
- Sanity: `npm run typecheck && npm test` should be green before changing anything.

## Phase 1 — Configure providers (all optional)
- `cp .env.example .env`  (`.env` is gitignored)
- Ask me which providers I use, then set **only those** in `.env`:
  - **Official (opt-in — registers only when its key is present):**
    `OPENROUTER_KEY`, `OPENAI_ADMIN_KEY` (org **Admin** key `sk-admin…`),
    `ANTHROPIC_ADMIN_KEY` (org **Admin** key `sk-ant-admin…`), `DEEPSEEK_KEY`,
    `XAI_MANAGEMENT_KEY` (management-API, **not** consumer Grok),
    `BYTEPLUS_ACCESS_KEY` + `BYTEPLUS_SECRET_KEY` (account AK/SK).
  - **Unofficial local readers (no key):** Claude Code, Codex, ccusage, Grok —
    they self-discover the token the vendor CLI already stored on **this**
    machine. They only produce data where those CLIs are installed and logged in.
- Read `.env.example` comments for the exact meaning of each var. Do not paste any
  key into chat.

## Phase 2 — Run and verify locally
- `AUTH_MODE=open npm start`  (loopback dev only — see Phase 3 before exposing it)
- Verify:
  - `curl -s localhost:8787/api/health` → `{"status":"ok",...}`
  - open <http://127.0.0.1:8787> → cards render
  - `curl -s localhost:8787/api/snapshot | grep -i key` → **must be empty** (no
    credential ever appears in the snapshot)
- Some cards may show an honest error/"waiting" state (missing key, CLI not logged
  in, undocumented endpoint changed). That is expected fail-soft — **report which
  and why; do not try to fix a provider I didn't configure.**

## Phase 3 — Choose auth + topology (ask me first)
- **Auth:**
  - *Network-as-gate (recommended):* run behind **Tailscale** so only my devices
    reach the collector.
  - *Password:* set `DASHBOARD_PASSWORD` for a session/Bearer gate on the UI +
    `/api/snapshot` (`/api/health` stays open).
  - `AUTH_MODE=open` is **loopback only** — never expose it to a network.
- **Topology A (simplest):** the collector serves the UI over my tailnet.
  `tailscale serve --bg 8787`, then reach it at
  `https://<machine>.<tailnet>.ts.net`.
- **Topology B (pretty public URL, data still private):** a static UI on Vercel/CF
  that fetches the collector over Tailscale.
  `SNAPSHOT_BASE='https://<machine>.<tailnet>.ts.net' npm run build:web`, deploy
  `dist/web`, and set `CORS_ORIGINS` on the collector to the exact deployed origin.
- Follow **`deploy/README.md`** for the full walkthrough — don't improvise the
  network exposure. Do **not** enable Tailscale Funnel unless I explicitly want the
  collector on the public internet.

## Phase 4 — Durable service (macOS)
- `cp deploy/ai-usage-dashboard.plist ~/Library/LaunchAgents/`
- Edit the copy: set `Label`, `WorkingDirectory`, and (if using the age vault)
  `AGE_IDENTITY` to my real paths.
- `launchctl load ~/Library/LaunchAgents/ai-usage-dashboard.plist`
- Confirm: `launchctl list | grep ai-usage` and re-check the board is reachable.
- (Linux/other: a systemd user unit or `pm2 start "npm start"` works the same way.)

## Phase 5 — Secret hygiene (do not skip)
- `.env`, the age identity, and `.data/` are gitignored — never commit them.
- Run `npm run secret-scan` before any commit; it rejects real-looking key
  material. CI runs it too.

## Acceptance checklist
- [ ] `npm run typecheck && npm test && npm run secret-scan` all green.
- [ ] `/api/health` returns 200; `/api/snapshot` is key-free.
- [ ] The board renders my configured providers with correct `official` /
      `unofficial` chips and freshness badges.
- [ ] Auth matches what I chose (tailnet and/or password); `AUTH_MODE=open` is not
      exposed to any network.
- [ ] If durable: it survives a restart (launchd `KeepAlive`) and is reachable at
      my chosen URL.

## Common gotchas
- **OpenAI / Anthropic** cards need **org Admin** keys, not project keys — personal
  accounts can't call the org cost/usage APIs, so those cards stay omitted.
- **BytePlus** needs an account **AK/SK** (Volcengine sig v4), not the ARK
  inference key.
- **xAI** here means **management-API billing**, separate from the unofficial
  consumer-Grok reader.
- **Unofficial readers** fail soft unless the vendor CLI is installed and logged in
  on the collector machine.
- If a build step fails on `esbuild`, ensure dev dependencies installed and the
  platform binary is present (`node_modules/@esbuild/*`).
