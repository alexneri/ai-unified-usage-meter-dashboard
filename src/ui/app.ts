// Board app. The ONE network thing it does: fetch /api/snapshot. No provider key
// is ever held or requested. Front-end spec "API Interaction Layer".
//
// Topology A (collector-served): SNAPSHOT_BASE is empty → relative /api/snapshot.
// Topology B (Vercel/CF static): window.__AUD_CONFIG__.snapshotBase points at the
// Mac collector over Tailscale (e.g. https://<machine>.<tailnet>.ts.net). Config is
// injected at static-export time — never a provider secret.
//
// Rendering is the Claude Design v2 instrument: pressure-ranked hero + side +
// recessed, with FLIP re-sort, spring meter fills, and count-up numerals driven
// by ./motion. Cards are rebuilt each refresh but spring state persists by key,
// so approaching a cap is visible motion, not a teleport.
//
// Session + offline cache:
// - Hybrid login password persists in localStorage for the rest of the calendar
//   day (and at least 24h). Survives tab close / phone lock.
// - Last-good snapshot is written to localStorage so a cold load while the
//   collector is offline still paints the board with an offline indicator.

import type { ProviderSnapshot } from '../core/types.js';
import { buildCard, buildRecessed, deriveSync, isRecessed, pressure } from './card.js';
import { captureFlip, Motion, runFlip } from './motion.js';

declare global {
  interface Window {
    __AUD_CONFIG__?: { snapshotBase?: string };
  }
}

const board = document.getElementById('board') as HTMLElement;
const heroEl = document.getElementById('hero') as HTMLElement;
const sideEl = document.getElementById('side') as HTMLElement;
const recEl = document.getElementById('recessed') as HTMLElement;
const recHead = document.getElementById('recessed-head') as HTMLElement;
const recLabel = document.getElementById('recessed-label') as HTMLElement;
const notice = document.getElementById('notice') as HTMLElement;
const globalUpdated = document.getElementById('global-updated') as HTMLElement;
const refresh = document.getElementById('refresh') as HTMLButtonElement;
const loginForm = document.getElementById('login') as HTMLFormElement;
const loginInput = document.getElementById('login-pw') as HTMLInputElement;
const loginHint = document.getElementById('login-hint') as HTMLElement;
const linkStatus = document.getElementById('link-status') as HTMLElement | null;
const linkStatusLabel = document.getElementById('link-status-label') as HTMLElement | null;
const footerVersion = document.getElementById('footer-version') as HTMLElement | null;
const orderReset = document.getElementById('order-reset') as HTMLButtonElement | null;

// Injected at build time by scripts/build-ui.mjs (esbuild --define). Guarded with
// typeof so a bundle built without the define still runs (falls back to "dev").
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';

const motion = new Motion();
const expanded = new Set<string>();
const started = new Set<string>();
let lastGood: ProviderSnapshot[] | null = null;
let lastPollTs = 0;
let inFlight = false;
let collectorOnline: boolean | null = null;

// Manual tile order (drag-to-reorder). Empty = automatic pressure-ranking.
let customOrder: string[] = [];
// Pointer-drag state.
let isDragging = false;
let dragId: string | null = null;
let dragGhost: HTMLElement | null = null;
let dragMoved = false;
let dragStart = { x: 0, y: 0 };
let dropTargetId: string | null = null;
let dropBefore = false;

const PW_KEY = 'aud_password';
const PW_EXP_KEY = 'aud_password_exp';
const SNAP_KEY = 'aud_last_snapshot';
/** Keep a hybrid login for the rest of the calendar day, never less than 24h. */
const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_KEY = 'aud_card_order';

// ---------- durable hybrid password (localStorage, day-long) ----------

function endOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function passwordExpiry(now = Date.now()): number {
  return Math.max(now + DAY_MS, endOfLocalDay(now));
}

function readStoredPassword(now = Date.now()): string | null {
  try {
    const pw = localStorage.getItem(PW_KEY);
    const expRaw = localStorage.getItem(PW_EXP_KEY);
    if (!pw) return null;
    const exp = expRaw ? Number(expRaw) : NaN;
    if (!Number.isFinite(exp) || now > exp) {
      clearStoredPassword();
      return null;
    }
    return pw;
  } catch {
    return null;
  }
}

function storePassword(pw: string, now = Date.now()): void {
  try {
    localStorage.setItem(PW_KEY, pw);
    localStorage.setItem(PW_EXP_KEY, String(passwordExpiry(now)));
  } catch {
    // private mode / quota — fall through; session still works this tab
  }
  // Migrate away from the old sessionStorage path.
  try {
    sessionStorage.removeItem(PW_KEY);
  } catch {
    /* ignore */
  }
}

function clearStoredPassword(): void {
  try {
    localStorage.removeItem(PW_KEY);
    localStorage.removeItem(PW_EXP_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(PW_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- last-known snapshot cache ----------

function readCachedSnapshot(): ProviderSnapshot[] | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as ProviderSnapshot[];
  } catch {
    return null;
  }
}

function writeCachedSnapshot(snaps: ProviderSnapshot[]): void {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snaps));
  } catch {
    /* ignore */
  }
}

// ---------- expand ----------

function applyExp(id: string, x: number): void {
  const cl = Math.max(0, Math.min(1.05, x));
  const exp = board.querySelector<HTMLElement>(`[data-exp="${id}"]`);
  const inner = board.querySelector<HTMLElement>(`[data-expin="${id}"]`);
  const caret = board.querySelector<HTMLElement>(`[data-caret="${id}"]`);
  if (exp) exp.style.gridTemplateRows = `${cl}fr`;
  if (inner) inner.style.opacity = String(Math.min(1, cl));
  if (caret) caret.style.transform = `rotate(${Math.min(1, cl) * 180}deg)`;
}

function toggleExpand(id: string): void {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  const card = board.querySelector(`[data-flip="${id}"] .card`);
  if (card) card.setAttribute('aria-expanded', String(expanded.has(id)));
  motion.setSpring(`exp:${id}`, expanded.has(id) ? 1 : 0, {
    response: 0.5,
    eps: 0.004,
    apply: (x) => applyExp(id, x),
  });
}

// ---------- spring sync (bars, numerals, expand) ----------

function syncMeters(live: ProviderSnapshot[]): void {
  for (const snap of live) {
    const info = deriveSync(snap);

    for (const bar of info.bars) {
      const sk = `sb:${bar.key}`;
      const paint = (x: number): void => {
        const e = board.querySelector<HTMLElement>(`[data-bar="${bar.key}"]`);
        if (e) e.style.transform = `scaleX(${Math.max(0, Math.min(1, x))})`;
      };
      if (!started.has(sk)) {
        started.add(sk);
        motion.setSpring(sk, bar.target, { from: 0, response: 0.42, eps: 0.0015, apply: paint });
      } else {
        const v = motion.shown[sk];
        if (v != null) paint(v);
        motion.setSpring(sk, bar.target, { response: 0.42, eps: 0.0015, apply: paint });
      }
    }

    if (info.num) {
      const nk = info.num.key;
      const fmt = info.num.fmt;
      const paint = (x: number): void => {
        const e = board.querySelector<HTMLElement>(`[data-num="${snap.providerId}"]`);
        if (e) e.textContent = fmt(x);
      };
      if (!started.has(nk)) {
        started.add(nk);
        motion.setSpring(nk, info.num.target, { from: 0, response: 0.5, eps: info.num.eps, apply: paint });
      } else {
        const v = motion.shown[nk];
        if (v != null) paint(v);
        motion.setSpring(nk, info.num.target, { response: 0.5, eps: info.num.eps, apply: paint });
      }
    }

    const ek = `exp:${snap.providerId}`;
    const tgt = expanded.has(snap.providerId) ? 1 : 0;
    applyExp(snap.providerId, motion.shown[ek] != null ? motion.shown[ek] : tgt);
    motion.setSpring(ek, tgt, { response: 0.5, eps: 0.004, apply: (x) => applyExp(snap.providerId, x) });
  }
}

// ---------- manual order + drag-to-reorder ----------

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* ignore */
  }
}

function orderActive(): boolean {
  return customOrder.length > 0;
}

function updateOrderControl(): void {
  if (orderReset) orderReset.hidden = !orderActive();
}

/** Sort live providers by the user's manual order when set, else by pressure. */
function sortLive(list: ProviderSnapshot[]): ProviderSnapshot[] {
  if (!orderActive()) return [...list].sort((a, b) => pressure(b) - pressure(a));
  const idx = (id: string): number => {
    const i = customOrder.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  return [...list].sort((a, b) => {
    const ia = idx(a.providerId);
    const ib = idx(b.providerId);
    if (ia === ib) return pressure(b) - pressure(a); // both unknown → pressure
    return ia - ib; // known first by slot; unknown (Infinity) sinks to the end
  });
}

/** Once a manual order exists, give any newly-seen provider a stable slot at the end. */
function rememberNewProviders(live: ProviderSnapshot[]): void {
  if (!orderActive()) return;
  let changed = false;
  for (const s of live) {
    if (!customOrder.includes(s.providerId)) {
      customOrder.push(s.providerId);
      changed = true;
    }
  }
  if (changed) writeOrder(customOrder);
}

function resetOrder(): void {
  customOrder = [];
  try {
    localStorage.removeItem(ORDER_KEY);
  } catch {
    /* ignore */
  }
  updateOrderControl();
  if (lastGood) render(lastGood);
}

function liveCardEls(excludeId?: string): HTMLElement[] {
  return Array.from(
    board.querySelectorAll<HTMLElement>('#hero [data-flip], #side [data-flip]'),
  ).filter((c) => c.getAttribute('data-flip') !== excludeId);
}

function onReorderStart(id: string, ev: PointerEvent): void {
  if (isDragging) return;
  isDragging = true;
  dragId = id;
  dragMoved = false;
  dragStart = { x: ev.clientX, y: ev.clientY };
  dropTargetId = null;
  dropBefore = false;
  window.addEventListener('pointermove', onReorderMove);
  window.addEventListener('pointerup', onReorderEnd);
  window.addEventListener('pointercancel', onReorderEnd);
}

function beginGhost(id: string): void {
  const snap = (lastGood ?? []).find((s) => s.providerId === id);
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = snap?.displayName ?? id;
  document.body.append(ghost);
  dragGhost = ghost;
  document.body.classList.add('is-reordering');
  board.querySelector<HTMLElement>(`[data-flip="${id}"]`)?.classList.add('is-drag-source');
}

function onReorderMove(ev: PointerEvent): void {
  if (!isDragging || !dragId) return;
  const dx = ev.clientX - dragStart.x;
  const dy = ev.clientY - dragStart.y;
  if (!dragMoved && Math.hypot(dx, dy) < 5) return; // distinguish a tap from a drag
  if (!dragMoved) {
    dragMoved = true;
    beginGhost(dragId);
  }
  ev.preventDefault();
  if (dragGhost) {
    dragGhost.style.left = `${ev.clientX}px`;
    dragGhost.style.top = `${ev.clientY}px`;
  }
  const hit = hitTest(ev.clientX, ev.clientY, dragId);
  setDropIndicator(hit ? hit.id : null, hit ? hit.before : false);
}

function hitTest(x: number, y: number, excludeId: string): { id: string; before: boolean } | null {
  let best: { id: string; before: boolean } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of liveCardEls(excludeId)) {
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const dist = inside ? -1 : Math.hypot(x - cx, y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      const sameRow = Math.abs(y - cy) <= r.height / 2;
      const before = y < cy - r.height * 0.05 || (sameRow && x < cx);
      best = { id: c.getAttribute('data-flip') as string, before };
    }
    if (inside) break;
  }
  return best;
}

function setDropIndicator(id: string | null, before: boolean): void {
  if (dropTargetId === id && dropBefore === before) return;
  board
    .querySelectorAll('.is-drop-before, .is-drop-after')
    .forEach((e) => e.classList.remove('is-drop-before', 'is-drop-after'));
  dropTargetId = id;
  dropBefore = before;
  if (!id) return;
  board.querySelector(`[data-flip="${id}"]`)?.classList.add(before ? 'is-drop-before' : 'is-drop-after');
}

function cleanupDrag(): void {
  dragGhost?.remove();
  dragGhost = null;
  document.body.classList.remove('is-reordering');
  board
    .querySelectorAll('.is-drag-source, .is-drop-before, .is-drop-after')
    .forEach((e) => e.classList.remove('is-drag-source', 'is-drop-before', 'is-drop-after'));
}

function onReorderEnd(): void {
  window.removeEventListener('pointermove', onReorderMove);
  window.removeEventListener('pointerup', onReorderEnd);
  window.removeEventListener('pointercancel', onReorderEnd);
  const id = dragId;
  const targetId = dropTargetId;
  const before = dropBefore;
  const moved = dragMoved;
  cleanupDrag();
  dragId = null;
  dropTargetId = null;
  dropBefore = false;
  dragMoved = false;
  isDragging = false;
  if (id && moved && targetId && targetId !== id) commitReorder(id, targetId, before);
}

function commitReorder(id: string, targetId: string, before: boolean): void {
  // Base order = the live cards as currently displayed (hero first, then side).
  const base = liveCardEls()
    .map((c) => c.getAttribute('data-flip') as string)
    .filter((x) => x && x !== id);
  let ti = base.indexOf(targetId);
  if (ti === -1) return;
  if (!before) ti += 1;
  base.splice(ti, 0, id);
  // Preserve slots for providers remembered earlier but currently recessed/absent.
  const extra = customOrder.filter((x) => !base.includes(x));
  customOrder = [...base, ...extra];
  writeOrder(customOrder);
  updateOrderControl();
  if (lastGood) render(lastGood);
}

// ---------- render ----------

function render(snaps: ProviderSnapshot[]): void {
  const from = captureFlip(board);

  const live = sortLive(snaps.filter((s) => !isRecessed(s)));
  rememberNewProviders(live);
  const rec = snaps.filter(isRecessed).sort((a, b) => (a.error ? 0 : 1) - (b.error ? 0 : 1));
  const hero = live[0];
  const side = live.slice(1);
  const ctx = (id: string) => ({ expanded: expanded.has(id), onToggle: toggleExpand, onReorderStart });

  heroEl.replaceChildren(...(hero ? [buildCard(hero, 'hero', ctx(hero.providerId))] : []));
  sideEl.replaceChildren(...side.map((s) => buildCard(s, 'side', ctx(s.providerId))));
  recEl.replaceChildren(...rec.map(buildRecessed));

  recLabel.textContent = `NO DATA · ${rec.length}`;
  recHead.hidden = rec.length === 0;
  recEl.hidden = rec.length === 0;

  runFlip(board, from, motion);
  syncMeters(live);

  const newest = snaps
    .map((s) => Date.parse(s.fetchedAt))
    .filter((t) => !Number.isNaN(t) && t > 0)
    .sort((a, b) => b - a)[0];
  if (newest) lastPollTs = newest;
  updateAgo();
}

// ---------- "updated … ago" + link status ----------

function fmtAgo(secs: number): string {
  if (secs < 2) return 'updated just now';
  if (secs < 60) return `updated ${secs}s ago`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `updated ${m}m ${String(secs % 60).padStart(2, '0')}s ago`;
  const h = Math.floor(m / 60);
  return `updated ${h}h ${String(m % 60).padStart(2, '0')}m ago`;
}

function updateAgo(): void {
  if (!lastPollTs) {
    globalUpdated.textContent = 'updated —';
    return;
  }
  const label = fmtAgo(Math.max(0, Math.round((Date.now() - lastPollTs) / 1000)));
  globalUpdated.textContent =
    collectorOnline === false ? `last known · ${label.replace(/^updated /, '')}` : label;
}

function setLinkStatus(state: 'online' | 'offline' | 'unknown', label: string): void {
  if (!linkStatus || !linkStatusLabel) return;
  linkStatus.dataset.state = state;
  linkStatusLabel.textContent = label;
}

function showOfflineNotice(hasCache: boolean): void {
  notice.hidden = false;
  notice.dataset.kind = 'offline';
  notice.textContent = hasCache
    ? snapshotBase()
      ? 'Collector offline — showing last known snapshot. Is the Mac awake / are you on the tailnet?'
      : 'Collector offline — showing last known snapshot. Is the Mac awake?'
    : snapshotBase()
      ? 'Collector offline — no cached snapshot yet. Is the Mac awake / are you on the tailnet?'
      : 'Collector offline — no cached snapshot yet. Is the Mac awake?';
}

function showLive(): void {
  collectorOnline = true;
  notice.hidden = true;
  notice.removeAttribute('data-kind');
  board.classList.remove('is-dim', 'is-offline');
  setLinkStatus('online', 'collector live');
  updateAgo();
}

function showOffline(hasCache: boolean): void {
  collectorOnline = false;
  showOfflineNotice(hasCache);
  if (hasCache) board.classList.add('is-dim', 'is-offline');
  else board.classList.remove('is-dim', 'is-offline');
  setLinkStatus('offline', 'collector offline');
  updateAgo();
}

// ---------- login ----------

function showLogin(hint: string): void {
  loginHint.textContent = hint;
  loginForm.hidden = false;
  loginInput.focus();
}

function hideLogin(): void {
  loginForm.hidden = true;
  loginHint.textContent = '';
}

// ---------- fetch ----------

function snapshotBase(): string {
  const raw = window.__AUD_CONFIG__?.snapshotBase?.trim() ?? '';
  return raw.replace(/\/+$/, '');
}

function snapshotUrl(): string {
  const base = snapshotBase();
  return base ? `${base}/api/snapshot` : '/api/snapshot';
}

async function load(): Promise<void> {
  if (inFlight || isDragging) return; // don't rebuild cards mid-drag
  inFlight = true;
  refresh.disabled = true;
  refresh.classList.add('is-spin');
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // Hybrid (cross-origin): Bearer from day-long localStorage. Same-origin uses
    // the collector session cookie (also day-long, HMAC-signed, restart-safe).
    const pw = readStoredPassword();
    if (pw) headers.authorization = `Bearer ${pw}`;

    const crossOrigin = Boolean(snapshotBase());
    const res = await fetch(snapshotUrl(), {
      headers,
      credentials: crossOrigin ? (pw ? 'omit' : 'include') : 'same-origin',
    });
    if (res.status === 401) {
      if (crossOrigin) {
        if (pw) clearStoredPassword();
        notice.hidden = true;
        notice.removeAttribute('data-kind');
        setLinkStatus('unknown', 'sign in');
        showLogin(pw ? 'Wrong password — try again.' : 'This collector requires a password.');
      } else {
        notice.hidden = false;
        notice.dataset.kind = 'auth';
        notice.textContent = 'Unauthorized — reload to sign in.';
        window.location.reload();
      }
      return;
    }
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const snaps = (await res.json()) as ProviderSnapshot[];
    lastGood = snaps;
    writeCachedSnapshot(snaps);
    hideLogin();
    showLive();
    render(snaps);
  } catch {
    // Collector unreachable — paint last-known (memory or localStorage) + offline cue.
    if (!lastGood) lastGood = readCachedSnapshot();
    if (lastGood) {
      showOffline(true);
      render(lastGood);
    } else {
      showOffline(false);
    }
  } finally {
    inFlight = false;
    refresh.disabled = false;
    refresh.classList.remove('is-spin');
  }
}

// ---------- wiring ----------

refresh.addEventListener('click', () => void load());

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = loginInput.value.trim();
  if (!value) return;
  storePassword(value);
  loginInput.value = '';
  hideLogin();
  void load();
});

// Footer build version + manual-order control.
if (footerVersion) footerVersion.textContent = APP_VERSION;
customOrder = readOrder();
updateOrderControl();
orderReset?.addEventListener('click', resetOrder);

// Cold start: paint cached board immediately so offline/reload isn't a blank flash.
const bootCache = readCachedSnapshot();
if (bootCache) {
  lastGood = bootCache;
  render(bootCache);
  setLinkStatus('unknown', 'checking…');
} else {
  setLinkStatus('unknown', '—');
}

void load();
// Auto-refresh so ranking/staleness stay honest; tick relative time every second.
setInterval(() => void load(), 60_000);
setInterval(updateAgo, 1_000);
