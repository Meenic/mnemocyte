import Link from "next/link";
import { cn } from "@/lib/cn";

const MARK =
  "M4 1h3v1h-3zM2 2h2v1h-2zM2 3h1v1h-1zM1 4h1v4h-1zM10 5h1v3h-1zM2 8h1v1h-1zM9 8h1v1h-1zM2 9h2v1h-2zM8 9h2v1h-2zM4 10h4v1h-4zM6 4h2v2h-2z";

/** The 12 × 12 pixel cell mark: an open membrane, a nucleus and one pink pixel. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={className}
    >
      <path fill="currentColor" d={MARK} />
      {/* The pink pixel steps one pixel down-left when the logo is hovered. */}
      <path
        className="fill-primary [transition:translate_.25s_steps(2)] group-hover:-translate-x-px group-hover:translate-y-px motion-reduce:transition-none"
        d="M10 1h1v1h-1z"
      />
    </svg>
  );
}

/** Mark plus wordmark, linking home. */
export function Logo({
  href = "/",
  className,
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label="Mnemocyte home"
      className={cn(
        "group flex items-center gap-2.5 text-ink no-underline",
        className,
      )}
    >
      <LogoMark className="size-5.5" />
      <span className="heading-type text-logo">mnemocyte</span>
    </Link>
  );
}
