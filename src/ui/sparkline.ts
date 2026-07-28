// Sparkline — builds the expand-panel trend SVG from a provider's OWN Series.
// Never invents points: returns null when there is nothing real to plot.

import type { Series } from '../core/types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 240;
const H = 64;
const PAD = 3;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/**
 * Build a trend polyline from `series`. Percent series scale to a fixed 0–100
 * with an 80% threshold line (matching the gauge's near-cap marker); other
 * units auto-scale with headroom. Returns null for series with < 2 points.
 */
export function buildSparkline(series: Series, height = 76): SVGSVGElement | null {
  const pts = series.points.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;

  const isPct = series.unit === 'percent';
  const mx = isPct ? 100 : Math.max(...pts) * 1.18 || 1;
  const x = (i: number): number => PAD + (i * (W - 2 * PAD)) / (pts.length - 1);
  const y = (v: number): number => H - PAD - (Math.max(0, Math.min(v, mx)) / mx) * (H - 2 * PAD);

  const svg = svgEl('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('spark');
  svg.style.height = `${height}px`;

  if (isPct) {
    const thresh = svgEl('line');
    thresh.setAttribute('x1', '0');
    thresh.setAttribute('x2', String(W));
    thresh.setAttribute('y1', y(80).toFixed(1));
    thresh.setAttribute('y2', y(80).toFixed(1));
    thresh.setAttribute('stroke', 'var(--acc)');
    thresh.setAttribute('stroke-width', '1');
    thresh.setAttribute('stroke-dasharray', '3 4');
    thresh.setAttribute('opacity', '0.5');
    thresh.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(thresh);
  }

  const line = svgEl('polyline');
  line.setAttribute('points', pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#c6ccd2');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);

  const last = pts[pts.length - 1] as number;
  const dot = svgEl('circle');
  dot.setAttribute('cx', x(pts.length - 1).toFixed(1));
  dot.setAttribute('cy', y(last).toFixed(1));
  dot.setAttribute('r', '2.6');
  dot.setAttribute('fill', 'var(--acc)');
  svg.appendChild(dot);

  return svg;
}
