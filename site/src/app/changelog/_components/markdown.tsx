import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ComponentProps } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { InlineCode } from "@/components/ui/inline-code";
import { cn } from "@/lib/cn";
import { markdownToHast } from "@/lib/markdown";

interface MarkdownProps {
  markdown: string;
  /** Render one paragraph without its <p>, for headings and list items. */
  inline?: boolean;
}

function Anchor({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      {...props}
      className={cn(
        "underline decoration-1 underline-offset-4 hover:decoration-primary",
        className,
      )}
    />
  );
}

function Code({ children }: ComponentProps<"code">) {
  return <InlineCode>{children}</InlineCode>;
}

/* A fenced block: undo the inline code box on its <code>. */
function Pre({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      {...props}
      className={cn(
        "overflow-x-auto border border-line bg-surface p-(--s-2) text-code [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em]",
        className,
      )}
    />
  );
}

/** Markdown from the repository, rendered at build time. */
export function Markdown({ markdown, inline = false }: MarkdownProps) {
  return toJsxRuntime(markdownToHast({ markdown, inline }), {
    Fragment,
    jsx,
    jsxs,
    components: { a: Anchor, code: Code, pre: Pre },
  });
}
