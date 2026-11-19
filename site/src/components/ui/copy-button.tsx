"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

type Tone = "light" | "dark" | "onPrimary";
type State = "idle" | "copied" | "failed";

interface CopyButtonProps {
  text: string;
  /** Accessible name, such as "Copy install command". */
  label?: string;
  /** light: inside an outlined install box. dark: on a code block. onPrimary: on the pink card. */
  tone?: Tone;
}

const base =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 [transition:color_.15s,background-color_.15s] motion-reduce:transition-none";

/*
 * Each tone has its resting look (with hover and active) and its "Copied"
 * look. The copied look replaces the resting one instead of layering on
 * it, so a hover can never cover the confirmation.
 */
const tones: Record<Tone, { shape: string; idle: string; copied: string }> = {
  light: {
    shape: "min-w-23 border-l border-line px-3.5 text-sm",
    idle: "bg-transparent text-ink-soft hover:bg-bg hover:text-ink active:bg-line",
    copied: "bg-primary text-on-primary",
  },
  dark: {
    shape:
      "h-8.5 min-w-21 border px-3 text-code focus-visible:outline-on-ink focus-visible:-outline-offset-4",
    idle: "border-slab-line bg-transparent text-on-ink-soft hover:bg-slab-hover hover:text-on-ink",
    copied: "border-primary bg-primary text-on-primary",
  },
  onPrimary: {
    shape: "min-w-23 border-l border-ink px-3.5 text-sm",
    idle: "bg-transparent text-ink hover:bg-ink/10",
    copied: "bg-ink text-primary",
  },
};

function fallbackCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Copies text, shows a pixel check and "Copied" for 1.5 s, then resets. */
export function CopyButton({
  text,
  label = "Copy",
  tone = "light",
}: CopyButtonProps) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = fallbackCopy(text);
    }
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  };

  const look = tones[tone];

  return (
    <button
      type="button"
      className={cn(
        base,
        look.shape,
        state === "copied" ? look.copied : look.idle,
      )}
      aria-label={label}
      onClick={copy}
    >
      {state === "copied" && (
        <svg
          viewBox="0 0 5 4"
          aria-hidden="true"
          className="h-2.5 w-3 [shape-rendering:crispEdges]"
        >
          <path
            fill="currentColor"
            d="M4 0h1v1H4zM3 1h1v1H3zM2 2h1v1H2zM0 1h1v1H0zM1 2h1v1H1zM1 3h1v1H1z"
          />
        </svg>
      )}
      {state === "idle" ? "Copy" : state === "copied" ? "Copied" : "Press ⌘C"}
      <span className="sr-only" role="status">
        {state === "copied" ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
