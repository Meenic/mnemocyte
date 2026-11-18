"use client";

import { useEffect, useRef } from "react";
import type { CellPalette } from "@/lib/colony/cell";
import {
  Colony as ColonyEngine,
  type ColonyOptions,
} from "@/lib/colony/engine";
import { cssVar, toAbgr } from "@/lib/colony/pixel";

/* The canvas is placed by the engine and may extend past its box: off the
   right edge on wide screens, edge to edge on narrow ones (body clips it). */
const CANVAS =
  "absolute max-w-none touch-manipulation [image-rendering:pixelated]";
const NARROW = "(max-width: 960px)";
const REDUCED = "(prefers-reduced-motion: reduce)";
const NO_TEXTS: readonly string[] = [];
const CARD: Partial<ColonyOptions> = {
  density: 420,
  rMin: 3.8,
  rSpan: 3.2,
  fade: [8, 8, 8, 8],
  recallGap: [2.2, 4],
};

interface ColonyProps {
  /**
   * hero: ink on the page background, interactive, bleeds off the right
   * edge on wide screens and spans the full width on narrow ones.
   * card: ink on the pink closing card, decorative, fills its box.
   */
  variant: "hero" | "card";
  /**
   * Memory texts read out to screen readers when a cell is recalled (hero only).
   * Pass a module-level constant: a new array on every render restarts the colony.
   */
  texts?: readonly string[];
}

function readPalette(variant: ColonyProps["variant"]): CellPalette {
  if (variant === "card") {
    return {
      ink: toAbgr(cssVar("--ink")),
      grain: toAbgr(cssVar("--cell-grain-on-primary")),
      link: toAbgr(cssVar("--cell-link-on-primary")),
      hot: toAbgr(cssVar("--on-ink")),
    };
  }
  return {
    ink: toAbgr(cssVar("--ink")),
    grain: toAbgr(cssVar("--cell-grain")),
    link: toAbgr(cssVar("--cell-link")),
    hot: toAbgr(cssVar("--primary")),
  };
}

export function Colony({ variant, texts = NO_TEXTS }: ColonyProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);
  const interactive = variant === "hero";

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;

    const reduced = window.matchMedia(REDUCED).matches;
    const narrow = window.matchMedia(NARROW);
    const engine = new ColonyEngine(canvas, {
      palette: readPalette(variant),
      texts,
      ...(variant === "card" ? CARD : {}),
    });

    const place = () => {
      const rect = box.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      if (variant === "card") {
        engine.layout(0, 0, rect.width, rect.height);
      } else if (narrow.matches) {
        Object.assign(engine, { scale: 4, density: 300, rMin: 3.8, rSpan: 3 });
        engine.fade = [10, 6, 10, 6];
        engine.layout(-rect.left, 0, vw, rect.height);
      } else {
        Object.assign(engine, {
          scale: 5,
          density: 380,
          rMin: 4.2,
          rSpan: 3.6,
        });
        engine.fade = [22, 8, 0, 8];
        engine.layout(0, 0, vw - rect.left, rect.height);
      }
      engine.draw();
    };
    place();

    let placeFrame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(placeFrame);
      placeFrame = requestAnimationFrame(place);
    });
    resize.observe(box);
    window.addEventListener("resize", place);

    let visible = true;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(box);

    let frame = 0;
    let last = 0;
    const loop = (ts: number) => {
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      if (visible && !document.hidden) {
        engine.step(dt);
        engine.draw();
      }
      frame = requestAnimationFrame(loop);
    };
    if (!reduced) frame = requestAnimationFrame(loop);

    // Interaction: hover or tap recalls a cell; arrow keys pick one, Enter recalls it.
    const announce = () => {
      const c = engine.hover;
      if (liveRef.current) {
        liveRef.current.textContent = c
          ? `${c.text}. Strength ${c.s.toFixed(2)}.`
          : "";
      }
    };
    const redrawIfStill = () => {
      if (reduced) engine.draw();
    };
    let lastRecall = -9;
    const onPoint = (event: PointerEvent) => {
      const c = engine.pick(event.clientX, event.clientY);
      if (c && (c !== engine.hover || engine.t - lastRecall > 1.2)) {
        engine.recall(c, !reduced);
        lastRecall = engine.t;
      }
      engine.hover = c;
      if (c) announce();
      canvas.style.cursor = c ? "pointer" : "default";
      redrawIfStill();
    };
    const onLeave = () => {
      if (document.activeElement === box) return;
      engine.hover = null;
      redrawIfStill();
    };
    const onFocus = () => {
      engine.hover = engine.ordered()[0] ?? null;
      announce();
      redrawIfStill();
    };
    const onBlur = () => {
      engine.hover = null;
      redrawIfStill();
    };
    const onKey = (event: KeyboardEvent) => {
      const list = engine.ordered();
      if (!list.length) return;
      let i = Math.max(0, engine.hover ? list.indexOf(engine.hover) : 0);
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        i = (i + 1) % list.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        i = (i - 1 + list.length) % list.length;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (engine.hover) engine.recall(engine.hover, !reduced);
        announce();
        redrawIfStill();
        return;
      } else {
        return;
      }
      event.preventDefault();
      engine.hover = list[i] ?? null;
      announce();
      redrawIfStill();
    };

    if (interactive) {
      canvas.addEventListener("pointermove", onPoint);
      canvas.addEventListener("pointerdown", onPoint);
      canvas.addEventListener("pointerleave", onLeave);
      box.addEventListener("focus", onFocus);
      box.addEventListener("blur", onBlur);
      box.addEventListener("keydown", onKey);
    }

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(placeFrame);
      resize.disconnect();
      io.disconnect();
      window.removeEventListener("resize", place);
      canvas.removeEventListener("pointermove", onPoint);
      canvas.removeEventListener("pointerdown", onPoint);
      canvas.removeEventListener("pointerleave", onLeave);
      box.removeEventListener("focus", onFocus);
      box.removeEventListener("blur", onBlur);
      box.removeEventListener("keydown", onKey);
    };
  }, [variant, texts, interactive]);

  if (!interactive) {
    return (
      <div
        ref={boxRef}
        className="relative h-70 w-full max-w-100 justify-self-end max-lg:h-45 max-lg:max-w-none max-lg:justify-self-stretch"
        aria-hidden="true"
      >
        <canvas ref={canvasRef} className={CANVAS} />
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className="relative min-h-70 self-stretch focus-visible:outline-offset-8 max-lg:h-45 max-lg:min-h-0"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the colony is keyboard-operable (arrow keys pick a memory, Enter recalls it)
      tabIndex={0}
      role="img"
      aria-label="A living colony of memories. Use the arrow keys to pick a memory and Enter to recall it."
    >
      <canvas ref={canvasRef} className={CANVAS} />
      <p ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  );
}
