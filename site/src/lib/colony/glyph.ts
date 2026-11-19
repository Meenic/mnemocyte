import { type CellPalette, drawCell } from "./cell";
import { ease } from "./pixel";

export type GlyphKind = "add" | "recall" | "merge" | "prune";

/** Phase used when motion is reduced: a representative still frame. */
export const STILL_PHASE: Record<GlyphKind, number> = {
  add: 0.75,
  recall: 0.25,
  merge: 0.9,
  prune: 0.42,
};

const SIZE = 20;
/** A seed whose nucleus sits centred, so small icons look tidy. */
const CENTRED = 17;

/**
 * Draws one 20 × 20 life-cycle icon at loop phase `p` (0–1) into `buf`,
 * a Uint32Array view of a 20 × 20 ImageData. Unpainted pixels stay
 * transparent, so the icon sits on whatever background is behind it.
 */
export function drawGlyph(
  buf: Uint32Array,
  kind: GlyphKind,
  p: number,
  palette: CellPalette,
): void {
  buf.fill(0);
  const put = (x: number, y: number, c: number) => {
    if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) buf[y * SIZE + x] = c;
  };
  const dots = (
    a: [number, number],
    b: [number, number],
    ra: number,
    rb: number,
    frac: number,
  ) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const n = Math.floor((len - ra - rb) * frac);
    for (let i = 0; i <= n; i += 2) {
      put(
        Math.floor(a[0] + ux * (ra + i)),
        Math.floor(a[1] + uy * (ra + i)),
        palette.link,
      );
    }
  };

  switch (kind) {
    case "add": {
      // A bud grows into a cell, then fades for the next loop.
      const R = 1.3 + 4.2 * ease(p, 0, 0.5);
      if (p < 0.9) {
        drawCell(put, 10.5, 10.5, R, {
          palette,
          young: R < 2.4,
          hot: p < 0.62,
          seed: CENTRED,
        });
      }
      break;
    }
    case "recall": {
      // A strong cell with a growth ring and a repeating pulse.
      drawCell(put, 10.5, 10.5, 4.5, {
        palette,
        ring: true,
        pulse: (p * 2) % 1,
        seed: CENTRED,
      });
      break;
    }
    case "merge": {
      // Three cells link up one after another.
      const A: [number, number] = [5.5, 13.5];
      const B: [number, number] = [14.5, 5.5];
      const C: [number, number] = [15.5, 15.5];
      dots(A, B, 5.5, 4.5, ease(p, 0.05, 0.35));
      dots(A, C, 5.5, 3.5, ease(p, 0.35, 0.6));
      dots(B, C, 4.5, 3.5, ease(p, 0.6, 0.8));
      drawCell(put, A[0], A[1], 4.2, { palette, seed: CENTRED });
      drawCell(put, B[0], B[1], 3.4, { palette, seed: CENTRED });
      drawCell(put, C[0], C[1], 2.2, { palette, seed: CENTRED });
      break;
    }
    case "prune": {
      // A cell breaks into loose pixels, then the loop starts again.
      const k = ease(p, 0.15, 0.85);
      if (p < 0.9) {
        drawCell(put, 10.5, 10.5, 5, {
          palette,
          weak: k < 0.05 ? 0.7 : 0,
          dying: k,
          seed: 7,
        });
      }
      break;
    }
  }
}
