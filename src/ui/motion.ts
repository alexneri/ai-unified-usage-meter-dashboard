// Motion system — a tiny critically-damped spring pool + FLIP helpers, ported
// from the Claude Design v2 prototype (design/claude-design-v2/design-script.js).
//
// Springs animate ONLY transform / opacity / grid-template-rows and are keyed by
// string so their state survives full DOM rebuilds: after a re-render we re-bind
// each spring's `apply` to whatever element currently matches its data-attribute.
// Under prefers-reduced-motion every spring snaps to target instantly.

interface SpringOpts {
  /** Seconds-ish period; ~0.4–0.55 reads as a firm, no-bounce settle. */
  response?: number;
  /** Convergence epsilon in the value's own units. */
  eps?: number;
  /** Optional start value (else resume from last shown, else target). */
  from?: number;
  apply: (x: number, done: boolean) => void;
}

interface Spring {
  x: number;
  vel: number;
  target: number;
  response: number;
  eps: number;
  apply: (x: number, done: boolean) => void;
}

export class Motion {
  /** Last painted value per key — survives DOM rebuilds so springs resume. */
  readonly shown: Record<string, number> = {};
  private readonly springs = new Map<string, Spring>();
  private raf = 0;
  private lastT = 0;

  /** True when the user prefers reduced motion; kept live via a media query. */
  reducedMotion = false;

  constructor() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const sync = () => {
        this.reducedMotion = mq.matches;
        if (mq.matches) this.settleAll();
      };
      sync();
      if (mq.addEventListener) mq.addEventListener('change', sync);
      else mq.addListener(sync);
    }
  }

  setSpring(key: string, target: number, o: SpringOpts): void {
    if (this.reducedMotion) {
      this.shown[key] = target;
      o.apply(target, true);
      this.springs.delete(key);
      return;
    }
    const existing = this.springs.get(key);
    const from = o.from != null ? o.from : this.shown[key] != null ? this.shown[key] : target;
    const s: Spring = existing ?? { x: from, vel: 0, target, response: 0.4, eps: 0.002, apply: o.apply };
    if (!existing) this.springs.set(key, s);
    else if (o.from != null) s.x = o.from;
    s.target = target;
    s.apply = o.apply;
    s.response = o.response ?? 0.4;
    s.eps = o.eps ?? 0.002;
    this.startLoop();
  }

  /** Snap every live spring to its target immediately (reduced-motion switch). */
  settleAll(): void {
    this.springs.forEach((s, key) => {
      s.x = s.target;
      this.shown[key] = s.x;
      s.apply(s.x, true);
    });
    this.springs.clear();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastT = performance.now();
    const step = (t: number): void => {
      this.raf = 0;
      const dt = Math.min(0.034, Math.max(0.001, (t - this.lastT) / 1000));
      this.lastT = t;
      let active = false;
      this.springs.forEach((s, key) => {
        const w = (2 * Math.PI) / s.response;
        s.vel += (-w * w * (s.x - s.target) - 2 * w * s.vel) * dt;
        s.x += s.vel * dt;
        if (Math.abs(s.x - s.target) < s.eps && Math.abs(s.vel) < s.eps * 25) {
          s.x = s.target;
          this.shown[key] = s.x;
          s.apply(s.x, true);
          this.springs.delete(key);
        } else {
          this.shown[key] = s.x;
          s.apply(s.x, false);
          active = true;
        }
      });
      if (active) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}

/** Rects captured from `[data-flip]` boxes just before a DOM rebuild. */
export type FlipRects = Record<string, DOMRect>;

export function captureFlip(root: ParentNode): FlipRects {
  const rects: FlipRects = {};
  root.querySelectorAll<HTMLElement>('[data-flip]').forEach((e) => {
    const id = e.getAttribute('data-flip');
    if (id) rects[id] = e.getBoundingClientRect();
  });
  return rects;
}

/**
 * FLIP the re-ranked cards from their old rects into their new positions. Under
 * reduced motion this degrades to a short opacity crossfade (no transform).
 */
export function runFlip(root: ParentNode, from: FlipRects, motion: Motion): void {
  const boxes = root.querySelectorAll<HTMLElement>('[data-flip]');
  boxes.forEach((e) => {
    const id = e.getAttribute('data-flip');
    if (!id || !from[id]) return;
    const ob = from[id];
    const nb = e.getBoundingClientRect();
    const dx = ob.left - nb.left;
    const dy = ob.top - nb.top;
    const sx = ob.width / Math.max(1, nb.width);
    const sy = ob.height / Math.max(1, nb.height);
    if (Math.abs(dx) + Math.abs(dy) < 3 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) return;

    const inner = e.querySelector<HTMLElement>('[data-flip-inner]');
    if (motion.reducedMotion) {
      e.style.opacity = '0';
      requestAnimationFrame(() => {
        e.style.transition = 'opacity .18s linear';
        e.style.opacity = '1';
        setTimeout(() => {
          e.style.transition = '';
        }, 240);
      });
      return;
    }
    e.style.willChange = 'transform';
    e.style.zIndex = '5';
    if (inner) inner.style.willChange = 'transform';
    motion.setSpring(`flip:${id}`, 0, {
      from: 1,
      response: 0.55,
      eps: 0.004,
      apply: (x, done) => {
        const gx = 1 + (sx - 1) * x;
        const gy = 1 + (sy - 1) * x;
        e.style.transformOrigin = 'top left';
        e.style.transform = `translate(${dx * x}px,${dy * x}px) scale(${gx},${gy})`;
        if (inner) {
          inner.style.transformOrigin = 'top left';
          inner.style.transform = `scale(${1 / gx},${1 / gy})`;
        }
        if (done) {
          e.style.transform = '';
          e.style.zIndex = '';
          e.style.willChange = '';
          if (inner) {
            inner.style.transform = '';
            inner.style.willChange = '';
          }
        }
      },
    });
  });
}
