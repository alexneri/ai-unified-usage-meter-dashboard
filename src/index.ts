// Collector entry point. Architecture §5 (pipeline): load config → register
// adapters → start scheduler → serve. The HTTP handlers do NO provider I/O on the
// request path: /api/snapshot reads the cache (read-through), /api/health reports
// liveness. The auth gate wraps the UI and /api/snapshot; /api/health stays open.

import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AuthGate } from './auth.js';
import { JsonFileCache } from './core/cache.js';
import { redact } from './core/normalize.js';
import { PollingScheduler } from './core/scheduler.js';
import { registerAll } from './providers/registry.js';
import { loadConfig } from './config.js';
import { HistoryCollector } from './core/history.js';

const log = (msg: string) => console.log(`[collector] ${redact(msg)}`);

const config = loadConfig(log);
const gate = new AuthGate(config.authMode, config.dashboardPassword);

const cache = new JsonFileCache(resolve(process.cwd(), config.cachePath));
const scheduler = new PollingScheduler({
  cache,
  resolveCredentials: (id) => config.credentialsFor(id),
  log,
});
registerAll((p) => scheduler.register(p), (id) => config.hasCredentials(id));

// Usage & cost history (ccusage daily) — its own background poller, kept out of the
// ProviderSnapshot pipeline because the payload shape differs (§4 invariant).
const history = new HistoryCollector({
  ledgerPath: resolve(process.cwd(), '.data/ledger.json'),
  machineId: process.env.USAGE_MACHINE_ID || hostname().replace(/\.local$/, '') || 'local',
  log,
});

const UI_DIR = resolve(process.cwd(), 'src/ui');
const DIST_UI_DIR = resolve(process.cwd(), 'dist/ui');

const app = new Hono();

// --- CORS for Topology B (Vercel/CF static UI → Mac collector). Same-origin
// Topology A needs no headers. Only exact Origins listed in CORS_ORIGINS.
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = origin && config.corsOrigins.includes(origin) ? origin : null;
  if (c.req.method === 'OPTIONS') {
    if (!allowed) return c.body(null, 204);
    c.header('Access-Control-Allow-Origin', allowed);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      c.req.header('access-control-request-headers') ?? 'Authorization, Content-Type, Accept',
    );
    c.header('Access-Control-Max-Age', '600');
    // Cookies only when the UI intentionally uses credentialed fetch + password mode.
    c.header('Access-Control-Allow-Credentials', 'true');
    return c.body(null, 204);
  }
  if (allowed) {
    c.header('Access-Control-Allow-Origin', allowed);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Credentials', 'true');
  }
  return next();
});

// --- Auth middleware: gate the UI + /api/snapshot; /api/health + /api/login open.
app.use('*', async (c, next) => {
  const path = c.req.path;
  const open =
    path === '/api/health' ||
    path === '/api/login' ||
    path === '/styles.css' ||
    path === '/app.js' ||
    path === '/history.js' ||
    path === '/favicon.png' ||
    path === '/apple-touch-icon.png' ||
    path === '/icon-192.png' ||
    path === '/icon-512.png';
  if (open || gate.isAuthed(c)) return next();
  if (path === '/api/snapshot') {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // UI routes: show the login page (password mode) or a closed notice.
  if (gate.requiresLogin) return c.html(loginPage(), 401);
  return c.html(closedPage(), 401);
});

// --- Open: liveness only. No usage values, no secrets, no provider call. (§7)
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    providers: scheduler.health(),
  }),
);

// --- Login (password mode): exchange the password for a session cookie.
app.post('/api/login', async (c) => {
  if (!gate.requiresLogin) return c.json({ error: 'login not enabled' }, 400);
  const password = await readPassword(c);
  const token = password ? gate.login(password) : null;
  if (!token) return c.json({ error: 'invalid password' }, 401);
  gate.setSessionCookie(c, token);
  return c.json({ ok: true });
});

// --- Auth-gated, key-free snapshot. Read-through from cache; NO provider call. (§7)
app.get('/api/snapshot', async (c) => {
  const snapshots = await scheduler.snapshotAll();
  return c.json(snapshots);
});

// --- Auth-gated usage & cost history. Read-through from the collector's last-good
// computation; NO subprocess on the request path (§7 parity with /api/snapshot).
app.get('/api/usage', (c) => c.json(history.get()));

// --- Static UI (dumb display).
app.get('/', async (c) => c.html(await readText(resolve(UI_DIR, 'index.html'))));
app.get('/styles.css', async (c) => {
  c.header('content-type', 'text/css; charset=utf-8');
  return c.body(await readText(resolve(UI_DIR, 'styles.css')));
});
app.get('/app.js', async (c) => {
  c.header('content-type', 'text/javascript; charset=utf-8');
  return c.body(await readText(resolve(DIST_UI_DIR, 'app.js')));
});

// --- Usage & cost history screen (additive; the main board is unchanged).
app.get('/history', async (c) => c.html(await readText(resolve(UI_DIR, 'history.html'))));
app.get('/history.js', async (c) => {
  c.header('content-type', 'text/javascript; charset=utf-8');
  return c.body(await readText(resolve(DIST_UI_DIR, 'history.js')));
});

// Bookmark / home-screen icons (must stay unauthenticated so Safari can fetch them).
for (const name of ['favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'] as const) {
  app.get(`/${name}`, async (c) => {
    c.header('content-type', 'image/png');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(await readFile(resolve(UI_DIR, name)));
  });
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function readPassword(c: import('hono').Context): Promise<string | undefined> {
  const ctype = c.req.header('content-type') ?? '';
  try {
    if (ctype.includes('application/json')) {
      const body = (await c.req.json()) as { password?: unknown };
      return typeof body.password === 'string' ? body.password : undefined;
    }
    const form = await c.req.parseBody();
    const p = form.password;
    return typeof p === 'string' ? p : undefined;
  } catch {
    return undefined;
  }
}

function loginPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Usage Dashboard — sign in</title><link rel="stylesheet" href="/styles.css"></head>
<body class="login"><main class="login__box"><h1>AI Usage Dashboard</h1>
<form method="post" action="/api/login" class="login__form">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
<button type="submit">Sign in</button></form>
<p class="login__note">This board is normally reached over Tailscale. The password is belt-and-suspenders.</p>
</main></body></html>`;
}

function closedPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Usage Dashboard — closed</title><link rel="stylesheet" href="/styles.css"></head>
<body class="login"><main class="login__box"><h1>Collector closed</h1>
<p class="login__note">No auth is configured. Set <code>DASHBOARD_PASSWORD</code> for a password gate,
or <code>AUTH_MODE=open</code> for local dev (unsafe on a shared network).
The recommended MVP model is Tailscale-only (Topology A) — see the README.</p>
</main></body></html>`;
}

if (gate.isOpen) {
  log('WARNING: AUTH_MODE=open — the board is served without a password. Use only on a trusted/loopback network.');
}
if (config.authMode === 'closed') {
  log('auth is CLOSED (no password, AUTH_MODE!=open). UI + /api/snapshot will 401. Set DASHBOARD_PASSWORD or AUTH_MODE=open.');
}

// Prime the cache once, then start staggered background polling.
scheduler
  .tick()
  .catch((e) => log(`initial tick failed: ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => scheduler.start());

// Prime usage history from the last-good file, refresh once, then poll in background.
history
  .load()
  .then(() => history.refresh())
  .catch((e) => log(`initial history load failed: ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => history.start());

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log(`listening on http://${config.host}:${info.port}  (auth: ${config.authMode})`);
});
