import { CopyButton } from "./CopyButton";

const COMMAND = "pnpm add mnemocyte";

const tones = {
  /* On the page background: a surface box that darkens its border on hover. */
  light:
    "border-line bg-surface hover:border-ink focus-within:border-ink [&_.prompt]:text-ink-soft",
  /* On the pink card: transparent, ink border, a softer prompt sign. */
  onPrimary: "border-ink bg-transparent [&_.prompt]:opacity-65",
} as const;

interface InstallBoxProps {
  tone?: keyof typeof tones;
  className?: string;
}

/** The `pnpm add mnemocyte` command with a copy button. */
export function InstallBox({ tone = "light", className }: InstallBoxProps) {
  return (
    <div
      className={[
        "inline-flex h-11.5 items-stretch border transition-[border-color] duration-150 motion-reduce:transition-none",
        tones[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <code className="flex items-center whitespace-nowrap px-4 text-sm max-sm:flex-1">
        <span className="prompt mr-2.5" aria-hidden="true">
          $
        </span>
        {COMMAND}
      </code>
      <CopyButton text={COMMAND} label="Copy install command" tone={tone} />
    </div>
  );
}
