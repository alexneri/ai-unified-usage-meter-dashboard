# Deployment

Two topologies. Hybrid **Topology B** is implemented for a static UI (Vercel/CF) +
Mac collector; Tailscale remains the network gate to the Mac.

## Topology A — Tailscale-only (collector serves UI)

The collector runs on your Mac, serves the UI **and** `/api/snapshot`, and is
reachable **only over the tailnet**. The network is the gate — zero public
exposure, zero-config auth.

1. **Bind to the tailnet (or loopback).** For loopback-only + Tailscale Serve,
   keep `HOST=127.0.0.1` and run `tailscale serve --bg 8787`. To bind directly to
   the tailnet IP, set `HOST` to your `100.x.y.z` address (or `0.0.0.0` if the
   host is otherwise firewalled to the tailnet).
2. **Optional belt-and-suspenders password.** Set `DASHBOARD_PASSWORD` so the UI +
   `/api/snapshot` also require a session even on the tailnet. `/api/health` stays
   open. For pure Tailscale trust with no password, set `AUTH_MODE=open` (the
   collector logs a warning) — only acceptable because the tailnet is the gate.
3. **Run as a durable service** (as the user, not root):
   ```sh
   cp deploy/ai-usage-dashboard.plist ~/Library/LaunchAgents/
   # edit Label, WorkingDirectory + AGE_IDENTITY paths inside the plist
   launchctl load ~/Library/LaunchAgents/ai-usage-dashboard.plist
   ```
   (`pm2 start "npm start"` or `tsx watch` also work for dev.)

The auth boundary: **the tailnet + optional password**. Nothing is public.

## Topology B — Hybrid (static UI on Vercel/CF + Mac collector)

Frontend on a static host (`*.vercel.app` etc.); the collector stays on your Mac
and holds every secret + local CLI reader. The browser (on a tailnet device)
fetches key-free `GET /api/snapshot` from the Mac over Tailscale HTTPS. **No
provider key ever reaches the static host.**

### 1. Install + login Tailscale on the Mac

```sh
brew install --cask tailscale   # needs macOS admin password once
open -a Tailscale               # complete browser/device login
# CLI (after app install):
#   /Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

### 2. Expose the collector on the tailnet (not the public internet)

```sh
# collector already on 127.0.0.1:8787
# HTTPS via Tailscale Serve (tailnet-only; do NOT enable Funnel unless you want public)
tailscale serve --bg 8787
tailscale serve status
# Note the https://<machine>.<tailnet>.ts.net URL — that is SNAPSHOT_BASE
```

Collector runtime env on the Mac:

```sh
HOST=127.0.0.1
PORT=8787
AUTH_MODE=open                 # OK only because the tailnet is the gate
# or DASHBOARD_PASSWORD=...    # belt-and-suspenders; hybrid UI uses Bearer via localStorage
CORS_ORIGINS=https://<project>.vercel.app
```

Restart the collector after changing env.

### 3. Deploy the static UI to Vercel

```sh
# One-time / CI: SNAPSHOT_BASE = Tailscale Serve HTTPS origin from step 2
export SNAPSHOT_BASE='https://<machine>.<tailnet>.ts.net'
npx vercel link                 # your Vercel project
npx vercel env add SNAPSHOT_BASE production   # same value
npx vercel --prod
```

`vercel.json` builds with `scripts/export-static-ui.mjs`, which writes
`dist/web/` and injects `window.__AUD_CONFIG__.snapshotBase`. Rebuild/redeploy
whenever the collector origin changes.

### 4. Hybrid auth notes

- **Default:** `AUTH_MODE=open` on the collector + Tailscale-only Serve. The
  public static page is a shell; browsers off the tailnet cannot reach the
  collector, so cards stay empty / "unreachable".
- **Password mode:** set `DASHBOARD_PASSWORD` on the collector. The UI persists a
  day-long password in `localStorage` and sends `Authorization: Bearer …`
  (cross-origin cookies are awkward).
- **CORS:** exact Origins only (`CORS_ORIGINS`). No wildcards. Add the production
  `https://…vercel.app` (and any preview URLs you care about).

### Invariants

- `/api/snapshot` is key-free (`ProviderSnapshot[]` only).
- The static host holds **zero** provider credentials.
- Local readers (Claude Code Keychain, Codex, Grok CLI) stay on the Mac.

## Choosing

| Need | Topology |
|------|----------|
| Only you, on your machines | A (simplest) or B with empty public shell |
| Pretty public URL, data still private | B + Tailscale Serve (no Funnel) |
| Reachable from any café Wi‑Fi without Tailscale | Not this design — would need CF Tunnel + Access or similar; keys still never leave the Mac |

The topologies differ in host + CORS/SNAPSHOT_BASE config, not in adapter code.
