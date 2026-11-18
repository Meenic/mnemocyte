import type { ReactNode } from "react";

/** A method or import path inside a sentence. */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="border border-line bg-surface px-1.25 text-[0.86em] text-ink">
      {children}
    </code>
  );
}
