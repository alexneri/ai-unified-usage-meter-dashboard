// Usage & cost history screen — a dumb display over /api/usage. Holds no provider
// key; fetches the collector's read-through UsageHistory and renders stat tiles, a
// hand-rolled SVG daily bar chart (cost/tokens toggle), and a by-model table.
// Same auth/topology idiom as app.ts (same-origin cookie, or day-long Bearer for
// the hybrid Vercel/CF deploy).

import type { UsageDay, UsageHistory, UsageModelStat } from '../core/history-types.js';
import { toCumulative } from '../core/history-types.js';

declare global {
  interface Window {
    __AUD_CONFIG__?: { snapshotBase?: string };
  }
}

declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';

const PW_KEY = 'aud_password';
const PW_EXP_KEY = 'aud_password_exp';

let metric: 'cost' | 'tokens' = 'cost';
let mode: 'daily' | 'cumulative' = 'daily';
let current: UsageHistory | null = null;

// ---------- dom helpers ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---------- formatting ----------

function fmtUSD(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function fmtX(x: number): string {
  return `${x.toFixed(1)}×`;
}
function fmtMetric(v: number): string {
  return metric === 'cost' ? fmtUSD(v) : `${fmtTokens(v)} tok`;
}

// ---------- auth / fetch ----------

function base(): string {
  return (window.__AUD_CONFIG__?.snapshotBase?.trim() ?? '').replace(/\/+$/, '');
}
function usageUrl(): string {
  const b = base();
  return b ? `${b}/api/usage` : '/api/usage';
}
function readPassword(now = Date.now()): string | null {
  try {
    const pw = localStorage.getItem(PW_KEY);
    const exp = Number(localStorage.getItem(PW_EXP_KEY) ?? '0');
    if (!pw) return null;
    if (exp && now > exp) {
      localStorage.removeItem(PW_KEY);
      localStorage.removeItem(PW_EXP_KEY);
      return null;
    }
    return pw;
  } catch {
    return null;
  }
}

async function load(): Promise<void> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const pw = readPassword();
  if (pw) headers.authorization = `Bearer ${pw}`;
  const crossOrigin = Boolean(base());
  try {
    const res = await fetch(usageUrl(), {
      headers,
      credentials: crossOrigin ? (pw ? 'omit' : 'include') : 'same-origin',
    });
    if (res.status === 401) {
      // Login lives on the main board — bounce there to authenticate, then return.
      window.location.href = '/';
      return;
    }
    if (!res.ok) throw new Error(`usage ${res.status}`);
    current = (await res.json()) as UsageHistory;
    hideNotice();
    render(current);
  } catch {
    showNotice(
      base()
        ? 'Collector offline — usage history unavailable. Is the Mac awake / are you on the tailnet?'
        : 'Collector offline — usage history unavailable. Is the Mac awake?',
    );
  }
}

// ---------- notices ----------

function showNotice(msg: string): void {
  const n = byId('notice');
  if (!n) return;
  n.hidden = false;
  n.dataset.kind = 'offline';
  n.textContent = msg;
}
function hideNotice(): void {
  const n = byId('notice');
  if (!n) return;
  n.hidden = true;
  n.removeAttribute('data-kind');
}

// ---------- render ----------

function render(h: UsageHistory): void {
  const updated = byId('history-updated');
  if (updated) {
    const t = Date.parse(h.generatedAt);
    updated.textContent =
      Number.isFinite(t) && t > 0 ? `updated ${new Date(t).toLocaleString()}` : 'not computed yet';
  }
  if (h.error && h.days.length === 0) {
    showNotice(`ccusage unavailable — ${h.error.message}`);
  }
  renderTiles(h);
  renderChart(h.days);
  renderModels(h.models);
}

function renderTiles(h: UsageHistory): void {
  const host = byId('history-tiles');
  if (!host) return;
  host.replaceChildren();
  const t = h.totals;
  const range = t.firstDate && t.lastDate ? `${t.firstDate} → ${t.lastDate} · ${t.days}d` : '—';
  const tiles: Array<{ label: string; value: string; sub: string; accent?: boolean }> = [
    { label: 'Est. spend (list price)', value: fmtUSD(t.cost), sub: `counterfactual · ${range}`, accent: true },
    { label: 'Cache leverage', value: fmtX(t.cacheLeverage), sub: 'cache reads ÷ fresh input' },
    { label: 'Processed', value: fmtTokens(t.processedTokens), sub: 'all token work' },
    { label: 'Cache read', value: fmtTokens(t.cacheReadTokens), sub: `${fmtPct(t.cacheReadShare)} of processed` },
    { label: 'Fresh input', value: fmtTokens(t.freshInputTokens), sub: 'input + cache writes' },
    { label: 'Output', value: fmtTokens(t.outputTokens), sub: 'generated tokens' },
  ];
  for (const tile of tiles) {
    const card = el('div', `hist-tile${tile.accent ? ' hist-tile--accent' : ''}`);
    card.appendChild(el('span', 'hist-tile__label', tile.label));
    card.appendChild(el('span', 'hist-tile__value', tile.value));
    card.appendChild(el('span', 'hist-tile__sub', tile.sub));
    host.appendChild(card);
  }
}

const CHART_H = 240;
const PAD_T = 14;
const PAD_B = 6;

function chartTitle(): string {
  if (mode === 'cumulative') return metric === 'cost' ? 'Cumulative estimated spend' : 'Cumulative tokens';
  return metric === 'cost' ? 'Daily estimated spend' : 'Daily tokens processed';
}

function renderChart(days: UsageDay[]): void {
  const host = byId('history-chart');
  const axis = byId('history-axis');
  const title = byId('chart-title');
  if (!host || !axis) return;
  host.replaceChildren();
  axis.replaceChildren();
  if (title) title.textContent = chartTitle();
  if (days.length === 0) {
    host.appendChild(el('p', 'hist-empty', 'No usage recorded yet.'));
    return;
  }

  const value = (d: UsageDay): number => (metric === 'cost' ? d.cost : d.totalTokens);
  const daily = days.map(value);
  const series = mode === 'cumulative' ? toCumulative(daily) : daily;
  const max = Math.max(...series, 0) || 1;
  const slot = 16;
  const barW = 10;
  const W = Math.max(days.length * slot, 280);
  const plotH = CHART_H - PAD_T - PAD_B;

  const chart = svg('svg');
  chart.setAttribute('viewBox', `0 0 ${W} ${CHART_H}`);
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('class', 'hist-svg');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `${chartTitle()} across ${days.length} days, peak ${fmtMetric(max)}`);

  // faint gridlines at 25/50/75/100%
  for (const g of [0.25, 0.5, 0.75, 1]) {
    const gy = PAD_T + (1 - g) * plotH;
    const line = svg('line');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', String(W));
    line.setAttribute('y1', gy.toFixed(1));
    line.setAttribute('y2', gy.toFixed(1));
    line.setAttribute('class', 'hist-grid');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    chart.appendChild(line);
  }

  if (mode === 'cumulative') {
    const xAt = (i: number): number => (days.length === 1 ? W / 2 : (i * W) / (days.length - 1));
    const yAt = (v: number): number => CHART_H - PAD_B - (v / max) * plotH;
    const pts = series.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
    const baseY = (CHART_H - PAD_B).toFixed(1);
    const area = svg('path');
    area.setAttribute(
      'd',
      `M ${xAt(0).toFixed(1)},${baseY} L ${pts.join(' L ')} L ${xAt(days.length - 1).toFixed(1)},${baseY} Z`,
    );
    area.setAttribute('class', 'hist-area');
    chart.appendChild(area);
    const line = svg('polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('class', 'hist-line');
    line.setAttribute('fill', 'none');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    chart.appendChild(line);
    const dot = svg('circle');
    dot.setAttribute('cx', xAt(days.length - 1).toFixed(1));
    dot.setAttribute('cy', yAt(series[series.length - 1]!).toFixed(1));
    dot.setAttribute('r', '2.8');
    dot.setAttribute('class', 'hist-dot');
    chart.appendChild(dot);
    // invisible per-day hover targets for the running-total tooltip
    const w = W / days.length;
    days.forEach((d, i) => {
      const r = svg('rect');
      r.setAttribute('x', (xAt(i) - w / 2).toFixed(1));
      r.setAttribute('y', '0');
      r.setAttribute('width', w.toFixed(1));
      r.setAttribute('height', String(CHART_H));
      r.setAttribute('fill', 'transparent');
      const tip = svg('title');
      tip.textContent = `${d.date} · cumulative ${fmtMetric(series[i]!)}`;
      r.appendChild(tip);
      chart.appendChild(r);
    });
  } else {
    days.forEach((d, i) => {
      const v = series[i]!;
      const h = (v / max) * plotH;
      const x = i * slot + (slot - barW) / 2;
      const y = CHART_H - PAD_B - h;
      const rect = svg('rect');
      rect.setAttribute('x', x.toFixed(1));
      rect.setAttribute('y', y.toFixed(1));
      rect.setAttribute('width', String(barW));
      rect.setAttribute('height', Math.max(h, 0.6).toFixed(1));
      rect.setAttribute('rx', '1.5');
      rect.setAttribute('class', 'hist-bar');
      const tip = svg('title');
      tip.textContent = `${d.date} · ${fmtMetric(v)}${d.agents.length ? ` · ${d.agents.join(', ')}` : ''}`;
      rect.appendChild(tip);
      chart.appendChild(rect);
    });
  }

  host.appendChild(chart);

  // caption + date axis (first / mid / last)
  host.appendChild(el('span', 'hist-peak', `${mode === 'cumulative' ? 'total' : 'peak'} ${fmtMetric(max)}`));
  const first = days[0]!;
  const mid = days[Math.floor((days.length - 1) / 2)]!;
  const last = days[days.length - 1]!;
  axis.appendChild(el('span', 'hist-axis__label', first.date));
  if (days.length > 2) axis.appendChild(el('span', 'hist-axis__label', mid.date));
  axis.appendChild(el('span', 'hist-axis__label', last.date));
}

function renderModels(models: UsageModelStat[]): void {
  const table = byId<HTMLTableElement>('history-models');
  if (!table) return;
  table.replaceChildren();
  const cols = ['Model', 'Est. cost', 'Input', 'Output', 'Cache write', 'Cache read', 'Total'];
  const thead = el('thead');
  const hr = el('tr');
  cols.forEach((c, i) => {
    const th = el('th', i === 0 ? 'hist-th hist-th--name' : 'hist-th hist-th--num', c);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (models.length === 0) {
    const tr = el('tr');
    const td = el('td', 'hist-td', 'No model data yet.');
    td.colSpan = cols.length;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const m of models) {
    const tr = el('tr');
    tr.appendChild(el('td', 'hist-td hist-td--name', m.model));
    tr.appendChild(el('td', 'hist-td hist-td--num', m.cost > 0 ? fmtUSD(m.cost) : '—'));
    tr.appendChild(el('td', 'hist-td hist-td--num', fmtTokens(m.inputTokens)));
    tr.appendChild(el('td', 'hist-td hist-td--num', fmtTokens(m.outputTokens)));
    tr.appendChild(el('td', 'hist-td hist-td--num', fmtTokens(m.cacheCreationTokens)));
    tr.appendChild(el('td', 'hist-td hist-td--num', fmtTokens(m.cacheReadTokens)));
    tr.appendChild(el('td', 'hist-td hist-td--num hist-td--total', fmtTokens(m.totalTokens)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

// ---------- wiring ----------

function setMetric(next: 'cost' | 'tokens'): void {
  if (metric === next) return;
  metric = next;
  const costBtn = byId('metric-cost');
  const tokBtn = byId('metric-tokens');
  costBtn?.classList.toggle('is-on', next === 'cost');
  costBtn?.setAttribute('aria-pressed', String(next === 'cost'));
  tokBtn?.classList.toggle('is-on', next === 'tokens');
  tokBtn?.setAttribute('aria-pressed', String(next === 'tokens'));
  if (current) renderChart(current.days);
}

byId('metric-cost')?.addEventListener('click', () => setMetric('cost'));
byId('metric-tokens')?.addEventListener('click', () => setMetric('tokens'));

function setMode(next: 'daily' | 'cumulative'): void {
  if (mode === next) return;
  mode = next;
  const dailyBtn = byId('mode-daily');
  const cumBtn = byId('mode-cumulative');
  dailyBtn?.classList.toggle('is-on', next === 'daily');
  dailyBtn?.setAttribute('aria-pressed', String(next === 'daily'));
  cumBtn?.classList.toggle('is-on', next === 'cumulative');
  cumBtn?.setAttribute('aria-pressed', String(next === 'cumulative'));
  if (current) renderChart(current.days);
}

byId('mode-daily')?.addEventListener('click', () => setMode('daily'));
byId('mode-cumulative')?.addEventListener('click', () => setMode('cumulative'));

const footerVersion = byId('footer-version');
if (footerVersion) footerVersion.textContent = APP_VERSION;

void load();
