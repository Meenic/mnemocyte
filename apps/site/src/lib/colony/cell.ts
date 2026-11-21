import { bayer, hash2 } from "./pixel";

/** Packed ABGR colors used to draw a cell. 0 means transparent. */
export interface CellPalette {
  /** Membrane and nucleus. */
  ink: number;
  /** Cytoplasm granules and the outer growth ring. */
  grain: number;
  /** Dotted links between cells. */
  link: number;
  /** Recalled or newborn cells, pulses and lit links (the accent). */
  hot: number;
}

export interface CellStyle {
  palette: CellPalette;
  /** Newborn: a small solid bud in the accent color. */
  young?: boolean;
  /** Recently recalled or hovered: membrane and ring in the accent color. */
  hot?: boolean;
  /** 0–1 while weakening: the membrane breaks into a dotted outline. 0 = intact. */
  weak?: number;
  /** Strong and often recalled: a dotted growth ring outside the membrane. */
  ring?: boolean;
  /** 0–1 progress of a recall pulse; outside that range, no pulse. */
  pulse?: number;
  /** 0–1 progress of dying: pixels drop out and drift away from the centre. */
  dying?: number;
  /** Per-cell seed for granules, nucleus shape and the dying scatter. */
  seed?: number;
  /** Horizontal and vertical stretch, about 0.88–1.12, so cells are not perfect circles. */
  ax?: number;
  ay?: number;
}

export type PutPixel = (x: number, y: number, color: number) => void;

/**
 * Draws one memory cell on a pixel grid, centred on (cx, cy) with radius R
 * in grid pixels.
 *
 * - young: small solid body
 * - mature: membrane, sparse granules, a round nucleus
 * - strong: dotted growth ring
 * - weak: broken membrane
 * - dying: loose pixels drifting outward
 */
export function drawCell(
  put: PutPixel,
  cx: number,
  cy: number,
  R: number,
  style: CellStyle,
): void {
  const { palette: C } = style;
  const fx = Math.floor(cx);
  const fy = Math.floor(cy);
  const ext = Math.ceil(R * 1.2 + 6);
  const seed = style.seed ?? 1;
  const ax = style.ax ?? 1;
  const ay = style.ay ?? 1;
  const solid = style.young === true || R < 2.4;
  const wall = style.hot ? C.hot : C.ink;
  const pulse = style.pulse ?? -1;
  const dying = style.dying ?? 0;
  const weak = style.weak ?? 0;

  // Nucleus: a small round blob, centred on a pixel or on a pixel corner.
  const onCorner = seed % 2 === 1;
  const rn = Math.max(1.1, R * (onCorner ? 0.26 : 0.3));
  const ncx = cx + (onCorner ? 0.5 : 0);
  const ncy = cy + (onCorner ? 0.5 : 0);

  for (let y = fy - ext; y <= fy + ext; y++) {
    for (let x = fx - ext; x <= fx + ext; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const e = Math.hypot(dx / ax, dy / ay);
      const h = hash2(x, y, seed);
      let c = 0;

      if (solid) {
        if (e <= R) c = style.hot || style.young ? C.hot : C.ink;
      } else if (Math.abs(e - R) < 0.55) {
        if (!weak || bayer(x, y) < weak * 16) c = wall;
      } else if (e < R - 0.55) {
        const dn = Math.hypot(x + 0.5 - ncx, y + 0.5 - ncy);
        if (dn <= rn) c = C.ink;
        else if (e < R - 1.2 && dn > rn + 0.8 && h % 9 < 2) c = C.grain;
      } else if (
        style.ring &&
        Math.abs(e - (R + 2.5)) < 0.5 &&
        bayer(x, y) < 8
      ) {
        c = style.hot ? C.hot : C.grain;
      }

      if (!c && pulse >= 0 && pulse < 1) {
        const pr = R + 1.5 + pulse * 3.5;
        if (Math.abs(e - pr) < 0.5 && (h % 100) / 100 > pulse * pulse) {
          c = C.hot;
        }
      }
      if (!c) continue;

      if (dying > 0) {
        if ((h % 100) / 100 < dying * 0.9) continue;
        const k = dying * (1.5 + ((h >> 9) % 4));
        const len = d || 1;
        put(Math.round(x + (dx / len) * k), Math.round(y + (dy / len) * k), c);
      } else {
        put(x, y, c);
      }
    }
  }
}
