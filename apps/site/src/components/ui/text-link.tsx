import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface TextLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/** An underlined link with an arrow; the underline turns pink on hover. */
export function TextLink({ href, children, className }: TextLinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex gap-2 border-b-2 border-ink pb-0.5 font-medium no-underline transition-[border-color] duration-150 hover:border-primary active:opacity-70 motion-reduce:transition-none",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="[transition:translate_.2s_steps(3)] group-hover:translate-x-1 motion-reduce:transition-none"
      >
        →
      </span>
    </Link>
  );
}
