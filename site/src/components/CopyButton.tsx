"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./copy-button.module.css";

interface CopyButtonProps {
  text: string;
  /** Accessible name, such as "Copy install command". */
  label?: string;
  /** light: inside an outlined install box. dark: on a code block. onPrimary: on the pink card. */
  tone?: "light" | "dark" | "onPrimary";
}

type State = "idle" | "copied" | "failed";

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

  return (
    <button
      type="button"
      className={styles.copy}
      data-tone={tone}
      data-state={state}
      aria-label={label}
      onClick={copy}
    >
      {state === "copied" && (
        <svg viewBox="0 0 5 4" aria-hidden="true" className={styles.check}>
          <path
            fill="currentColor"
            d="M4 0h1v1H4zM3 1h1v1H3zM2 2h1v1H2zM0 1h1v1H0zM1 2h1v1H1zM1 3h1v1H1z"
          />
        </svg>
      )}
      {state === "idle" ? "Copy" : state === "copied" ? "Copied" : "Press ⌘C"}
      <span className={styles.status} role="status">
        {state === "copied" ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
