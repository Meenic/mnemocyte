import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const base =
  "group inline-flex items-center justify-center gap-2.5 border font-medium no-underline cursor-pointer [transition:background-color_.15s,color_.15s,border-color_.15s,translate_.08s] active:translate-y-px motion-reduce:transition-none [&_svg]:size-4";

const variants = {
  /* Ink fill that turns pink on hover. */
  ink: "border-ink bg-ink text-on-ink hover:border-primary hover:bg-primary hover:text-on-primary",
  /* Hairline outline that darkens on hover. */
  line: "border-line bg-transparent text-ink hover:border-ink hover:bg-surface",
} as const;

const sizes = {
  md: "h-11.5 px-5 text-ui",
  sm: "h-9.5 px-3.5 text-sm",
} as const;

interface ButtonStyle {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  className?: string;
}

/** The button classes, for a real <button> that should look the same. */
export function buttonClasses({
  variant = "ink",
  size = "md",
  className,
}: ButtonStyle = {}) {
  return cn(base, variants[variant], sizes[size], className);
}

interface ButtonProps extends ButtonStyle {
  href: string;
  children: ReactNode;
  /** Adds the → that nudges right on hover. */
  arrow?: boolean;
}

/** A link styled as a button. Paths starting with "/" use next/link. */
export function Button({
  href,
  children,
  variant = "ink",
  size = "md",
  arrow = false,
  className,
}: ButtonProps) {
  const classes = buttonClasses({ variant, size, className });
  const content = (
    <>
      {children}
      {arrow && (
        <span
          aria-hidden="true"
          className="[transition:translate_.2s_steps(3)] group-hover:translate-x-1 motion-reduce:transition-none"
        >
          →
        </span>
      )}
    </>
  );

  return href.startsWith("/") ? (
    <Link href={href} className={classes}>
      {content}
    </Link>
  ) : (
    <a href={href} className={classes}>
      {content}
    </a>
  );
}
