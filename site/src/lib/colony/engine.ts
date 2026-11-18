import { type CellPalette, drawCell } from "./cell";
import { bayer } from "./pixel";

export interface Cell {
  id: number;
  x: number;
  y: number;
  parent: Cell | null;
  /** Lineage: cells that grew from the same seed share a root. */
  root: number;
  /** Strength, 0–1. Decays on a half-life; a recall adds 0.38. */
  s: number;
  ax: number;
  ay: number;
  /** Size multiplier, so cells of equal strength still differ in size. */
  k: number;
  born: number;
  /** Time of the last recall. */
  act: number;
  recalls: number;
  /** Time it started dying, or 0. */
  dying: number;
  /** Time of the last recall pulse. */
  pulse: number;
  seed: number;
  /** The memory this cell stands for, read out to screen readers. */
  text: string;
}

interface Link {
  a: Cell;
  b: Cell;
  born: number;
}

export interface ColonyOptions {
  palette: CellPalette;
  /** CSS pixels per grid pixel. */
  scale?: number;
  /** Grid pixels² per cell; lower means a denser colony. */
  density?: number;
  /** Cell radius in grid pixels at strength 0, and the extra at strength 1. */
  rMin?: number;
  rSpan?: number;
  /** Seconds for an unrecalled cell to lose half its strength. */
  half?: number;
  /** Seconds between automatic recalls, as [min, max]. */
  recallGap?: [number, number];
  /** Dithered fade at the edges, in grid pixels: [left, top, right, bottom]. */
  fade?: [number, number, number, number];
  /** Memory texts handed to cells in turn. */
  texts?: readonly string[];
}

/**
 * A colony of memory cells on a small pixel grid. It has no DOM knowledge
 * beyond the canvas it draws into: the caller decides the canvas's CSS
 * size and position (see `layout`), runs `step` and `draw` each frame, and
 * forwards pointer and keyboard input.
 */
export class Colony {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  palette: CellPalette;
  scale: number;
  density: number;
  rMin: number;
  rSpan: number;
  half: number;
  recallGap: [number, number];
  fade: [number, number, number, number];
  texts: readonly string[];

  W = 0;
  H = 0;
  t = 0;
  cells: Cell[] = [];
  hover: Cell | null = null;

  private links = new Map<string, Link>();
  private img: ImageData | null = null;
  private buf: Uint32Array = new Uint32Array(0);
  private mask: Uint8Array = new Uint8Array(0);
  private id = 0;
  private target = 0;
  private nextSpawn = 0;
  private nextRecall = 2;

  constructor(canvas: HTMLCanvasElement, options: ColonyOptions) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Colony needs a 2D canvas context");
    this.canvas = canvas;
    this.ctx = ctx;
    this.palette = options.palette;
    this.scale = options.scale ?? 5;
    this.density = options.density ?? 380;
    this.rMin = options.rMin ?? 4.2;
    this.rSpan = options.rSpan ?? 3.6;
    this.half = options.half ?? 18;
    this.recallGap = options.recallGap ?? [3, 5.5];
    this.fade = options.fade ?? [20, 8, 0, 8];
    this.texts = options.texts ?? [];
  }

  /**
   * Sizes and positions the canvas (CSS pixels, relative to its positioned
   * parent). The grid is rebuilt and re-grown only when its size changes.
   */
  layout(left: number, top: number, width: number, height: number): void {
    const W = Math.max(8, Math.floor(width / this.scale));
    const H = Math.max(8, Math.floor(height / this.scale));
    Object.assign(this.canvas.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${W * this.scale}px`,
      height: `${H * this.scale}px`,
    });
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.img = this.ctx.createImageData(W, H);
    this.buf = new Uint32Array(this.img.data.buffer);
    const [fl, ft, fr, fb] = this.fade;
    this.mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const f = Math.min(
          fl ? x / fl : 1,
          ft ? y / ft : 1,
          fr ? (W - 1 - x) / fr : 1,
          fb ? (H - 1 - y) / fb : 1,
          1,
        );
        this.mask[y * W + x] = Math.round(Math.max(0, f) * 16);
      }
    }
    this.reset();
  }

  /** Starts a new colony and grows it for 35 simulated seconds, so the first frame is full. */
  reset(): void {
    this.cells = [];
    this.links.clear();
    this.t = 0;
    this.id = 0;
    this.nextSpawn = 0;
    this.nextRecall = 2;
    this.target = Math.max(5, Math.round((this.W * this.H) / this.density));
    for (let i = 0; i < 700; i++) this.step(0.05);
    this.draw();
  }

  size(c: Cell): number {
    return (this.rMin + this.rSpan * c.s) * c.k;
  }

  /** Current radius; newborn cells grow into their size over 3 seconds. */
  radius(c: Cell): number {
    const age = this.t - c.born;
    const R = this.size(c);
    return age < 3 ? 1.4 + (R - 1.4) * (age / 3) : R;
  }

  isHot(c: Cell): boolean {
    return c === this.hover || this.t - c.act < 1.4;
  }

  recall(c: Cell, pulse = true): void {
    c.s = Math.min(1, c.s + 0.38);
    c.recalls++;
    c.act = this.t;
    if (pulse) c.pulse = this.t;
  }

  /** Live cells, left to right, for keyboard navigation. */
  ordered(): Cell[] {
    return this.cells
      .filter((c) => !c.dying)
      .sort((a, b) => a.x - b.x || a.y - b.y);
  }

  /** The cell under a pointer, if any. */
  pick(clientX: number, clientY: number): Cell | null {
    const r = this.canvas.getBoundingClientRect();
    const gx = ((clientX - r.left) / r.width) * this.W;
    const gy = ((clientY - r.top) / r.height) * this.H;
    let best: Cell | null = null;
    let bd = Number.POSITIVE_INFINITY;
    for (const c of this.cells) {
      if (c.dying) continue;
      const d = Math.hypot(c.x - gx, c.y - gy) - this.radius(c);
      if (d < 1.5 && d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  step(dt: number): void {
    this.t += dt;
    const t = this.t;
    const k = 0.5 ** (dt / this.half);

    for (const c of this.cells) {
      if (c.dying || c === this.hover) continue;
      c.s *= k;
      if (c.s < 0.14) c.dying = t;
    }
    this.cells = this.cells.filter((c) => !c.dying || t - c.dying < 2.2);

    const alive = this.cells.filter((c) => !c.dying);
    if (t > this.nextSpawn && alive.length < this.target) {
      this.spawn();
      this.nextSpawn = t + 0.5 + Math.random();
    }
    if (t > this.nextRecall) {
      const ready = this.cells.filter((c) => !c.dying && t - c.born > 3);
      const pick = ready[Math.floor(Math.random() * ready.length)];
      if (pick) this.recall(pick);
      const [lo, hi] = this.recallGap;
      this.nextRecall = t + lo + Math.random() * (hi - lo);
    }
    this.updateLinks();
  }

  draw(): void {
    if (!this.img) return;
    const t = this.t;
    this.buf.fill(0);
    for (const L of this.links.values()) {
      const lit = L.a === this.hover || L.b === this.hover;
      this.line(L.a, L.b, Math.min(1, (t - L.born) / 1.2), lit);
    }
    const put = (x: number, y: number, color: number) => this.put(x, y, color);
    for (const c of this.cells) {
      const R = this.radius(c);
      drawCell(put, c.x, c.y, R, {
        palette: this.palette,
        young: t - c.born < 3 && R < this.rMin * 0.75,
        hot: this.isHot(c),
        weak: !c.dying && c.s < 0.3 ? c.s / 0.3 : 0,
        ring: !c.dying && c.recalls >= 4 && c.s > 0.7,
        pulse: (t - c.pulse) / 1.2,
        dying: c.dying ? (t - c.dying) / 2.2 : 0,
        seed: c.seed,
        ax: c.ax,
        ay: c.ay,
      });
    }
    this.ctx.putImageData(this.img, 0, 0);
  }

  private fits(x: number, y: number, r: number): boolean {
    if (x < 4 || x > this.W + 4 || y < r + 2 || y > this.H - r - 2) {
      return false;
    }
    return this.cells.every(
      (c) => Math.hypot(c.x - x, c.y - y) >= this.size(c) + r + 3.5,
    );
  }

  private add(x: number, y: number, parent: Cell | null): void {
    const id = this.id++;
    this.cells.push({
      id,
      x,
      y,
      parent,
      root: parent ? parent.root : id,
      s: 0.5 + Math.random() * 0.15,
      ax: 0.88 + Math.random() * 0.24,
      ay: 0.88 + Math.random() * 0.24,
      k: 0.72 + Math.random() * 0.5,
      born: this.t,
      act: -9,
      recalls: 0,
      dying: 0,
      pulse: -9,
      seed: Math.floor(Math.random() * 1e6),
      text: this.texts.length ? (this.texts[id % this.texts.length] ?? "") : "",
    });
  }

  /** Buds a new cell off a living one, or seeds a new colony if there is no room. */
  private spawn(): void {
    const rmax = (this.rMin + this.rSpan) * 1.22;
    const parents = this.cells.filter((c) => !c.dying && this.t - c.born > 1.5);
    for (let tries = 0; tries < 30 && parents.length; tries++) {
      const p = parents[Math.floor(Math.random() * parents.length)];
      if (!p) break;
      const a = Math.random() * Math.PI * 2;
      const dist = this.size(p) + rmax + 4 + Math.random() * 4;
      const x = Math.floor(p.x + Math.cos(a) * dist) + 0.5;
      const y = Math.floor(p.y + Math.sin(a) * dist * 0.85) + 0.5;
      if (this.fits(x, y, rmax)) {
        this.add(x, y, p);
        return;
      }
    }
    for (let tries = 0; tries < 30; tries++) {
      const x = Math.floor(this.W * (0.25 + Math.random() * 0.7)) + 0.5;
      const y = Math.floor(this.H * (0.25 + Math.random() * 0.5)) + 0.5;
      if (this.fits(x, y, rmax)) {
        this.add(x, y, null);
        return;
      }
    }
  }

  /** Parent–child links, plus up to three links between close cells of one lineage. */
  private updateLinks(): void {
    const t = this.t;
    const alive = this.cells.filter((c) => !c.dying);
    const aliveSet = new Set(alive);
    const seen = new Set<string>();
    const degree = new Map<Cell, number>();
    const link = (a: Cell, b: Cell) => {
      const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
      seen.add(key);
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
      if (!this.links.has(key)) this.links.set(key, { a, b, born: t });
    };
    for (const c of alive) {
      if (c.parent && aliveSet.has(c.parent)) link(c, c.parent);
    }
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (!a || !b || a.root !== b.root) continue;
        if ((degree.get(a) ?? 0) > 2 || (degree.get(b) ?? 0) > 2) continue;
        if (
          Math.hypot(a.x - b.x, a.y - b.y) <
          this.size(a) + this.size(b) + 9
        ) {
          link(a, b);
        }
      }
    }
    for (const key of this.links.keys()) {
      if (!seen.has(key)) this.links.delete(key);
    }
  }

  private put(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    if (bayer(x, y) >= (this.mask[i] ?? 0)) return;
    this.buf[i] = color;
  }

  /** A link that grows in over 1.2 s: dotted when idle, solid accent when lit. */
  private line(a: Cell, b: Cell, frac: number, lit: boolean): void {
    const ra = this.radius(a) + 2;
    const rb = this.radius(b) + 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < ra + rb) return;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const n = Math.floor((len - ra - rb) * frac);
    for (let i = 0; i <= n; i++) {
      if (!lit && i % 2) continue;
      this.put(
        Math.floor(a.x + ux * (ra + i)),
        Math.floor(a.y + uy * (ra + i)),
        lit ? this.palette.hot : this.palette.link,
      );
    }
  }
}
