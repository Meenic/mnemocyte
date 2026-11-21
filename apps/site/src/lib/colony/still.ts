import { Colony, type ColonyOptions } from "./engine";

interface StillInput extends ColonyOptions {
  /** Size in CSS pixels; the grid is this divided by `scale`. */
  width: number;
  height: number;
}

interface Still {
  /** Grid size in pixels. */
  width: number;
  height: number;
  /** Row-major RGBA bytes; untouched pixels are transparent. */
  rgba: Uint8ClampedArray;
}

/**
 * Grows a colony without a browser and returns its first full frame, for
 * images made at build time. The engine only needs `createImageData` and
 * `putImageData` from a canvas, so a minimal stand-in captures the frame.
 */
export function renderStill({ width, height, ...options }: StillInput): Still {
  let frame: Still | undefined;
  const context = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (image: {
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }) => {
      frame = { width: image.width, height: image.height, rgba: image.data };
    },
  };
  const canvas = { style: {}, width: 0, height: 0, getContext: () => context };

  // The stand-in implements only what Colony calls outside the browser
  // (layout, reset, draw), so it is cast to the DOM type the engine expects.
  const colony = new Colony(canvas as unknown as HTMLCanvasElement, options);
  colony.layout(0, 0, width, height);

  if (!frame) throw new Error("The colony drew no frame");
  return frame;
}
