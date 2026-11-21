import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ComponentProps } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { BundledLanguage } from "shiki";
import { cn } from "@/lib/cn";
import { highlight } from "@/lib/highlight";
import { CopyButton } from "./copy-button";

interface CodeBlockProps {
  code: string;
  lang?: BundledLanguage;
  className?: string;
}

/* Shiki's <pre>, restyled for the slab. It keeps Shiki's tabindex, so a
   wide block can be scrolled from the keyboard. */
function Pre({ className, style: _style, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      {...props}
      className={cn(
        className,
        "m-0 overflow-x-auto p-(--s-4) pb-11 text-ui leading-[1.8] [tab-size:2] focus-visible:outline-on-ink focus-visible:-outline-offset-4",
        "max-sm:px-5 max-sm:pt-14 max-sm:pb-7 max-sm:text-code max-sm:whitespace-pre-wrap",
      )}
    />
  );
}

/** Code on the notched ink slab, highlighted at build time, with a copy button. */
export async function CodeBlock({
  code,
  lang = "ts",
  className,
}: CodeBlockProps) {
  const tree = await highlight({ code, lang });

  return (
    <div
      className={cn(
        "relative bg-ink text-on-ink [clip-path:var(--notch)]",
        className,
      )}
    >
      <div className="absolute top-3 right-3">
        <CopyButton text={code} label="Copy code" tone="dark" />
      </div>
      {toJsxRuntime(tree, { Fragment, jsx, jsxs, components: { pre: Pre } })}
    </div>
  );
}
