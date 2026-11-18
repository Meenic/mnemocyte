/**
 * Small pixel helpers shared by the colony, the life-cycle icons and the
 * closing card. Colors are packed as little-endian ABGR so they can be
 * written straight into a Uint32Array view of ImageData.
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** 4 × 4 ordered-dither threshold (0–15) for a pixel. */
export function bayer(x: number, y: number): number {
  return BAYER[(y & 3) * 4 + (x & 3)] ?? 0;
}

/** Deterministic per-pixel hash, used to scatter granules and dying pixels. */
export function hash2(x: number, y: number, seed: number): number {
  return (
    (Math.imul(x, 73856093) ^
      Math.imul(y, 19349663) ^
      Math.imul(seed, 83492791)) >>>
    0
  );
}

/** Linear 0–1 progress of `p` between `a` and `b`, clamped. */
export function ease(p: number, a: number, b: number): number {
  return Math.max(0, Math.min(1, (p - a) / (b - a)));
}

/**
 * Converts a CSS color (`#rrggbb`, `#rgb` or `rgb()`) to packed ABGR.
 * Read token values with getComputedStyle and pass them here, so the
 * artwork follows the design tokens instead of hard-coded colors.
 */
export function toAbgr(color: string): number {
  const c = color.trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.startsWith("#")) {
    const hex =
      c.length === 4
        ? c
            .slice(1)
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : c.slice(1, 7);
    const n = Number.parseInt(hex, 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const m = c.match(/\d+(\.\d+)?/g);
    if (m && m.length >= 3) {
      r = Number(m[0]);
      g = Number(m[1]);
      b = Number(m[2]);
    }
  }
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Mixes two CSS colors (0 = a, 1 = b) and returns packed ABGR. */
export function mixAbgr(a: string, b: string, t: number): number {
  const ca = toAbgr(a);
  const cb = toAbgr(b);
  const ch = (v: number, s: number) => (v >> s) & 255;
  const mix = (s: number) =>
    Math.round(ch(ca, s) + (ch(cb, s) - ch(ca, s)) * t);
  return ((255 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)) >>> 0;
}

/** Reads a CSS custom property from :root. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}
