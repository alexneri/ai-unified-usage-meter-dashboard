// Card rendering + display derivation for Claude Design v2.
//
// Dumb display: maps a real ProviderSnapshot to the instrument aesthetic
// (bento hero / side / recessed). All motion is driven from app.ts via the
// data-* hooks stamped here: data-flip / data-flip-inner (FLIP), data-bar
// (spring scaleX fills), data-num (count-up), data-exp / data-expin / data-caret
// (expand). This module holds NO network or spring logic.

import type { Meter, ProviderSnapshot, Series } from '../core/types.js';
import { buildSparkline } from './sparkline.js';

export type CardVariant = 'hero' | 'side';

export interface CardContext {
  expanded: boolean;
  onToggle: (id: string) => void;
  /** Optional: begin a pointer-drag reorder from the card's grip handle. */
  onReorderStart?: (id: string, ev: PointerEvent) => void;
}

// ---------- small DOM + format helpers ----------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t <= 0) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function untilTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.round((t - Date.now()) / 1000);
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function windowLabel(secs?: number): string {
  if (!secs) return '';
  if (secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  return `${Math.round(secs / 60)}m`;
}

function fmtNum(v: number): string {
  return Math.round(v).toLocaleString();
}

function fmtTok(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  return `$${v.toFixed(abs < 1 ? 4 : 2)}`;
}

function unitWord(m: Meter): string {
  switch (m.unit) {
    case 'tokens':
      return 'tokens';
    case 'requests':
      return 'req';
    default:
      return '';
  }
}

/** Fraction of the cap consumed, or null when no meaningful limit exists. */
function usedFrac(m: Meter): number | null {
  if (typeof m.limit !== 'number' || m.limit <= 0) return null;
  if (typeof m.remaining === 'number') return Math.max(0, Math.min(1, (m.limit - m.remaining) / m.limit));
  if (typeof m.value === 'number' && m.value <= m.limit) return Math.max(0, Math.min(1, m.value / m.limit));
  return null;
}

function usedValue(m: Meter): number {
  if (typeof m.remaining === 'number' && typeof m.limit === 'number') return m.limit - m.remaining;
  return m.value;
}

/** Decision meter: quota/balance/rate_limit with remaining, else spend, else first. */
export function primaryMeter(meters: Meter[]): Meter | undefined {
  const remaining = meters.find(
    (m) =>
      (m.kind === 'quota' || m.kind === 'balance' || m.kind === 'rate_limit') && typeof m.remaining === 'number',
  );
  if (remaining) return remaining;
  const spend = meters.find((m) => m.kind === 'spend');
  return spend ?? meters[0];
}

export function isRecessed(snap: ProviderSnapshot): boolean {
  return Boolean(snap.error) || snap.meters.length === 0;
}

/** Ranking pressure — higher wins the hero. Recessed cards score below all. */
export function pressure(snap: ProviderSnapshot): number {
  if (isRecessed(snap)) return -1;
  let max = 0.12; // floor so no-limit providers still rank above nothing
  for (const m of snap.meters) {
    const uf = usedFrac(m);
    if (uf != null) max = Math.max(max, uf);
  }
  return max;
}

// ---------- display model ----------

interface BarModel {
  key: string;
  target: number; // 0..1 scaleX
  near: boolean;
}

interface NumModel {
  target: number;
  eps: number;
  fmt: (x: number) => string;
}

interface SecModel {
  label: string;
  valText: string;
  bar: BarModel | null;
}

interface Model {
  id: string;
  name: string;
  official: boolean;
  confWord: string;
  confTitle: string;
  fresh: ProviderSnapshot['freshness'];
  statusWord: string;
  meterLabel: string;
  resetsText: string;
  unit: string;
  bigText: string;
  num: NumModel | null;
  subline: string;
  nearCap: boolean;
  capWord: string;
  primaryBar: BarModel | null;
  secondaries: SecModel[];
  series?: Series;
  metaLine: string;
}

function meterKey(id: string, index: number): string {
  return `${id}#${index}`;
}

function derive(snap: ProviderSnapshot): Model {
  const meters = snap.meters;
  const primary = primaryMeter(meters);
  const primaryIndex = primary ? meters.indexOf(primary) : -1;
  const official = snap.confidence === 'official';

  const model: Model = {
    id: snap.providerId,
    name: snap.displayName,
    official,
    confWord: official ? 'OFFICIAL' : 'UNOFFICIAL',
    confTitle: official ? 'real provider API — documented and stable' : 'best-effort local reader — may break',
    fresh: snap.freshness,
    statusWord: snap.freshness === 'live' ? 'LIVE' : snap.freshness === 'historical' ? 'HISTORICAL' : 'STALE',
    meterLabel: primary ? primary.label.toUpperCase() : '',
    resetsText: '',
    unit: '',
    bigText: '—',
    num: null,
    subline: '',
    nearCap: false,
    capWord: 'NEAR CAP',
    primaryBar: null,
    secondaries: [],
    series: snap.sparkline,
    metaLine: `${official ? 'official' : 'unofficial'} source · updated ${relTime(snap.fetchedAt)}`,
  };

  if (!primary) return model;

  // Resets / window line for the primary meter.
  if (primary.resetsAt) model.resetsText = `resets in ${untilTime(primary.resetsAt)}`;
  else if (primary.windowSeconds) model.resetsText = `window: ${windowLabel(primary.windowSeconds)}`;

  const uf = usedFrac(primary);
  if (uf != null) {
    // % used is the headline; subline reads "used of limit".
    model.unit = '%';
    model.num = { target: uf * 100, eps: 0.35, fmt: (x) => String(Math.round(x)) };
    model.bigText = String(Math.round(uf * 100));
    const word = unitWord(primary);
    model.subline = `${fmtNum(usedValue(primary))} of ${fmtNum(primary.limit as number)}${word ? ` ${word}` : ''}`;
    model.nearCap = uf >= 0.8;
    model.capWord = uf >= 0.98 ? 'AT CAP' : 'NEAR CAP';
    model.primaryBar = { key: meterKey(snap.providerId, primaryIndex), target: uf, near: uf >= 0.8 };
  } else {
    // No hard cap — show the raw figure in its own unit.
    if (primary.unit === 'usd') {
      model.num = { target: primary.value, eps: 0.01, fmt: fmtUsd };
      model.bigText = fmtUsd(primary.value);
      model.subline = `spend${primary.windowSeconds ? ` · ${windowLabel(primary.windowSeconds)}` : ''}`;
    } else if (primary.unit === 'tokens') {
      model.num = { target: primary.value, eps: 2500, fmt: fmtTok };
      model.bigText = fmtTok(primary.value);
      model.unit = 'tokens';
      model.subline = 'no hard limit';
    } else if (primary.unit === 'percent') {
      model.num = { target: primary.value, eps: 0.35, fmt: (x) => String(Math.round(x)) };
      model.bigText = String(Math.round(primary.value));
      model.unit = '%';
      model.subline = 'no hard limit';
    } else {
      model.num = { target: primary.value, eps: 0.5, fmt: fmtNum };
      model.bigText = fmtNum(primary.value);
      model.unit = unitWord(primary);
      model.subline = 'no hard limit';
    }
  }

  // Secondary meters.
  meters.forEach((m, i) => {
    if (m === primary) return;
    const suf = usedFrac(m);
    const resets = m.resetsAt ? ` · resets in ${untilTime(m.resetsAt)}` : m.windowSeconds ? ` · ${windowLabel(m.windowSeconds)}` : '';
    let valText: string;
    let bar: BarModel | null = null;
    if (suf != null) {
      valText = `${Math.round(suf * 100)}%${resets}`;
      bar = { key: meterKey(snap.providerId, i), target: suf, near: suf >= 0.8 };
    } else {
      const v =
        m.unit === 'usd' ? fmtUsd(m.value) : m.unit === 'tokens' ? fmtTok(m.value) : fmtNum(m.value);
      valText = `${v}${resets}`;
    }
    model.secondaries.push({ label: m.label.toUpperCase(), valText, bar });
  });

  return model;
}

/** Spring targets for a snapshot's live meters — consumed by app.syncMeters. */
export interface SyncInfo {
  id: string;
  num: (NumModel & { key: string }) | null;
  bars: BarModel[];
}

export function deriveSync(snap: ProviderSnapshot): SyncInfo {
  const m = derive(snap);
  const bars: BarModel[] = [];
  if (m.primaryBar) bars.push(m.primaryBar);
  for (const s of m.secondaries) if (s.bar) bars.push(s.bar);
  return { id: m.id, num: m.num ? { ...m.num, key: `num:${m.id}` } : null, bars };
}

// ---------- DOM builders ----------

function confChip(m: Model): HTMLElement {
  const chip = el('span', 'chip', m.confWord);
  chip.title = m.confTitle;
  const sq = el('span', m.official ? 'chip__sq' : 'chip__sq chip__sq--hollow');
  chip.prepend(sq);
  return chip;
}

function statusBadge(m: Model): HTMLElement {
  const wrap = el('span', 'status');
  wrap.append(
    el('span', `status__dot status__dot--${m.fresh}`),
    el('span', `status__word status__word--${m.fresh}`, m.statusWord),
  );
  return wrap;
}

function headRow(m: Model, nameCls: string): HTMLElement {
  const head = el('div', 'card__head');
  head.append(el('span', nameCls, m.name), confChip(m), statusBadge(m));
  return head;
}

function fillBar(bar: BarModel, cls: string, withMarker: boolean): HTMLElement {
  const wrap = el('div', cls);
  const fill = el('span', bar.near ? 'fill fill--near' : 'fill');
  fill.setAttribute('data-bar', bar.key);
  wrap.append(fill, el('span', 'bar__ticks'));
  if (withMarker) wrap.append(el('span', 'bar__marker'));
  return wrap;
}

function heroGauge(bar: BarModel): HTMLElement {
  const frag = el('div', 'gauge-wrap');
  const gauge = el('div', 'gauge');
  const fill = el('span', bar.near ? 'fill fill--near' : 'fill');
  fill.setAttribute('data-bar', bar.key);
  gauge.append(fill, el('span', 'gauge__minor'), el('span', 'gauge__major'), el('span', 'gauge__marker'));
  const scale = el('div', 'gauge__scale');
  for (const t of ['0', '20', '40', '60', '80', '100']) {
    scale.append(el('span', t === '80' ? 'is-acc' : undefined, t));
  }
  frag.append(gauge, scale);
  return frag;
}

function secondaryBlock(sec: SecModel, barCls: string): HTMLElement {
  const block = el('div', 'sec');
  const head = el('div', 'sec__head');
  head.append(el('span', 'sec__label', sec.label), el('span', 'sec__val', sec.valText));
  block.append(head);
  if (sec.bar) block.append(fillBar(sec.bar, barCls, false));
  return block;
}

function historyToggle(m: Model): HTMLElement {
  const row = el('div', 'history');
  row.append(el('span', 'history__word', 'HISTORY'));
  const caret = el('span', 'caret');
  caret.setAttribute('data-caret', m.id);
  row.append(caret);
  return row;
}

function expandPanel(m: Model, includeSecondaries: boolean): HTMLElement {
  const exp = el('div', 'expand');
  exp.setAttribute('data-exp', m.id);
  const inner = el('div', 'expand__inner');
  inner.setAttribute('data-expin', m.id);
  const body = el('div', 'expand__body');

  if (includeSecondaries) {
    for (const sec of m.secondaries) body.append(secondaryBlock(sec, 'bar bar--sec'));
  }
  const spark = m.series ? buildSpark(m.series) : null;
  if (spark) body.append(spark);
  body.append(el('div', 'meta-line', m.metaLine));

  inner.append(body);
  exp.append(inner);
  return exp;
}

function buildSpark(series: Series): HTMLElement | null {
  const svg = buildSparkline(series);
  if (!svg) return null;
  const wrap = el('div', 'spark-wrap');
  const cap = el('div', 'spark-cap');
  cap.append(el('span', 'sec__label', 'TREND'), el('span', 'spark-cap__note', `last ${series.points.length} polls`));
  wrap.append(cap, svg);
  return wrap;
}

/** Build a hero or side card (the pressure-ranked, expandable instruments). */
export function buildCard(snap: ProviderSnapshot, variant: CardVariant, ctx: CardContext): HTMLElement {
  const m = derive(snap);

  const flip = el('div', `card-flip card-flip--${variant}`);
  flip.setAttribute('data-flip', m.id);

  const card = el('div', `card card--${variant}`);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.setAttribute('aria-expanded', String(ctx.expanded));
  card.setAttribute('aria-label', `${m.name}, ${m.confWord.toLowerCase()}, ${m.statusWord.toLowerCase()}`);
  card.addEventListener('click', () => ctx.onToggle(m.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.onToggle(m.id);
    }
  });

  const inner = el('div', 'card__inner');
  inner.setAttribute('data-flip-inner', m.id);

  const head = headRow(m, variant === 'hero' ? 'card__name card__name--hero' : 'card__name');
  if (ctx.onReorderStart) head.prepend(buildGrip(m.id, ctx.onReorderStart));
  inner.append(head);

  const label = el('div', 'meter-head');
  label.append(el('span', 'meter__label', m.meterLabel), el('span', 'meter__resets', m.resetsText));
  inner.append(label);

  const big = el('div', 'bignum-row');
  const num = el('span', variant === 'hero' ? 'bignum bignum--hero' : 'bignum', m.bigText);
  num.setAttribute('data-num', m.id);
  big.append(num);
  if (m.unit) big.append(el('span', 'bignum__unit', m.unit));
  if (m.nearCap) {
    const cap = el('span', 'cap');
    cap.append(el('span', 'cap__sq'), el('span', 'cap__word', m.capWord));
    big.append(cap);
  }
  inner.append(big);
  inner.append(el('div', 'subline', m.subline));

  // Primary visual: gauge (limit) or inline trend (no limit).
  if (m.primaryBar) {
    inner.append(variant === 'hero' ? heroGauge(m.primaryBar) : fillBar(m.primaryBar, 'bar bar--primary', true));
  } else {
    const spark = m.series ? buildSpark(m.series) : null;
    if (spark) inner.append(spark);
  }

  // Hero shows secondaries inline; side tucks them into the expand panel.
  if (variant === 'hero') {
    for (const sec of m.secondaries) inner.append(secondaryBlock(sec, 'bar bar--sec'));
  }

  inner.append(expandPanel(m, variant === 'side'));
  inner.append(historyToggle(m));

  card.append(inner);
  flip.append(card);
  return flip;
}

/** Drag-to-reorder grip (pointer-based — works on touch, unlike HTML5 DnD).
 *  Its own pointerdown/click stop propagation so a grab never toggles expand. */
function buildGrip(id: string, onStart: (id: string, ev: PointerEvent) => void): HTMLElement {
  const grip = el('span', 'card__grip');
  grip.setAttribute('role', 'button');
  grip.setAttribute('aria-label', 'Drag to reorder');
  grip.title = 'Drag to reorder';
  for (let i = 0; i < 6; i++) grip.append(el('span', 'card__grip-dot'));
  grip.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    onStart(id, ev as PointerEvent);
  });
  grip.addEventListener('click', (ev) => ev.stopPropagation());
  return grip;
}

/** Build a recessed strip for an errored / not-yet-polled provider. */
export function buildRecessed(snap: ProviderSnapshot): HTMLElement {
  const official = snap.confidence === 'official';
  const isError = Boolean(snap.error);

  const flip = el('div', 'rec-flip');
  flip.setAttribute('data-flip', snap.providerId);
  const strip = el('div', 'rec-strip');
  strip.setAttribute('data-flip-inner', snap.providerId);

  const badge = el('span', 'rec-badge');
  if (isError) {
    badge.append(el('span', 'rec-tri'), el('span', 'rec-badge__word rec-badge__word--error', 'ERROR'));
  } else {
    badge.append(el('span', 'rec-dash'), el('span', 'rec-badge__word rec-badge__word--wait', 'WAITING'));
  }

  const nameWrap = el('span', 'rec-nameWrap');
  nameWrap.append(el('span', 'rec-name', snap.displayName));
  const chip = el('span', 'chip', official ? 'OFFICIAL' : 'UNOFFICIAL');
  chip.title = official ? 'real provider API' : 'best-effort local reader';
  chip.prepend(el('span', official ? 'chip__sq' : 'chip__sq chip__sq--hollow'));
  nameWrap.append(chip);

  const message = el('span', 'rec-msg', snap.error ? snap.error.message : 'waiting for first poll…');

  const aside = el('span', 'rec-aside');
  const hintText = isError
    ? snap.error?.retriable
      ? 'temporary — will retry'
      : official
        ? 'check config'
        : 'best-effort — may have changed'
    : 'first run';
  const validTs = Date.parse(snap.fetchedAt) > 0;
  const freshNote = isError
    ? validTs
      ? `stale · last OK ${relTime(snap.fetchedAt)}`
      : 'no successful poll yet'
    : validTs
      ? `last OK ${relTime(snap.fetchedAt)}`
      : 'never polled';
  aside.append(el('span', 'rec-hint', hintText), el('span', 'rec-fresh', freshNote));

  strip.append(badge, nameWrap, message, aside);
  strip.setAttribute(
    'aria-label',
    `${snap.displayName}, ${isError ? 'error' : 'waiting'}: ${snap.error ? snap.error.message : 'not yet fetched'}`,
  );
  flip.append(strip);
  return flip;
}
