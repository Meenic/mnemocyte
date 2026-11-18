import styles from "./logo.module.css";

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
      <path className={styles.pip} d="M10 1h1v1h-1z" />
    </svg>
  );
}

/** Mark plus wordmark, linking home. */
export function Logo({ href = "/" }: { href?: string }) {
  return (
    <a className={styles.brand} href={href} aria-label="Mnemocyte home">
      <LogoMark className={styles.mark} />
      <span className={styles.word}>mnemocyte</span>
    </a>
  );
}
