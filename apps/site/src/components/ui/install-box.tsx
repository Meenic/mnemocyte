import { cn } from "@/lib/cn";
import { CopyButton } from "./copy-button";

const COMMAND = "pnpm add mnemocyte";

const tones = {
  /* On the page background: a surface box that darkens its border on hover. */
  light: {
    box: "border-line bg-surface hover:border-ink focus-within:border-ink",
    prompt: "text-ink-soft",
  },
  /* On the pink card: transparent with an ink border and a softer prompt. */
  onPrimary: { box: "border-ink bg-transparent", prompt: "opacity-65" },
} as const;

interface InstallBoxProps {
  tone?: keyof typeof tones;
  className?: string;
}

/** The `pnpm add mnemocyte` command with a copy button. */
export function InstallBox({ tone = "light", className }: InstallBoxProps) {
  return (
    <div
      className={cn(
        "inline-flex h-11.5 items-stretch border transition-[border-color] duration-150 motion-reduce:transition-none",
        tones[tone].box,
        className,
      )}
    >
      <code className="flex items-center whitespace-nowrap px-4 text-sm max-sm:flex-1">
        <span className={cn("mr-2.5", tones[tone].prompt)} aria-hidden="true">
          $
        </span>
        {COMMAND}
      </code>
      <CopyButton text={COMMAND} label="Copy install command" tone={tone} />
    </div>
  );
}
