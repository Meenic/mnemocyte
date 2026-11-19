"use client";

import { useEffect, useRef } from "react";
import { drawGlyph, type GlyphKind, STILL_PHASE } from "@/lib/colony/glyph";
import { cssVar, toAbgr } from "@/lib/colony/pixel";

interface LifecycleIconProps {
  kind: GlyphKind;
  /** Seconds to offset this icon's loop, so neighbouring icons do not move in step. */
  offset?: number;
}

const LOOP_SECONDS = 4.5;
const FRAME_SECONDS = 0.1;

/** A 20 × 20 pixel icon for one life-cycle stage, gently animated at 10 fps. */
export function LifecycleIcon({ kind, offset = 0 }: LifecycleIconProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const img = ctx.createImageData(20, 20);
    const buf = new Uint32Array(img.data.buffer);
    const palette = {
      ink: toAbgr(cssVar("--ink")),
      grain: toAbgr(cssVar("--cell-grain")),
      link: toAbgr(cssVar("--cell-link")),
      hot: toAbgr(cssVar("--primary")),
    };
    const render = (phase: number) => {
      drawGlyph(buf, kind, phase, palette);
      ctx.putImageData(img, 0, 0);
    };

    render(STILL_PHASE[kind]);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let visible = false;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
    });
    io.observe(canvas);

    let frame = 0;
    let last = 0;
    let clock = offset;
    let tick = 0;
    const loop = (ts: number) => {
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      if (visible && !document.hidden) {
        clock += dt;
        tick += dt;
        if (tick >= FRAME_SECONDS) {
          tick = 0;
          render((clock / LOOP_SECONDS) % 1);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
    };
  }, [kind, offset]);

  return (
    <span className="block" aria-hidden="true">
      <canvas
        ref={canvasRef}
        width={20}
        height={20}
        className="block size-22 [image-rendering:pixelated] max-sm:size-16"
      />
    </span>
  );
}
