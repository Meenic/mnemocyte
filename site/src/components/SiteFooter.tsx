import Link from "next/link";
import { NAV_LINKS, NPM_URL, REPO_URL, SPONSOR_URL } from "@/lib/site";
import { Logo } from "./Logo";

const EXTERNAL_LINKS = [
  { href: REPO_URL, label: "GitHub" },
  { href: NPM_URL, label: "npm" },
  { href: SPONSOR_URL, label: "Sponsor" },
] as const;

const footLink =
  "text-ui text-ink-soft no-underline hover:text-ink hover:underline hover:underline-offset-4";

/** The footer: its top line aligns with the content column. */
export function SiteFooter() {
  return (
    <footer className="mt-(--section)">
      <div className="wrap">
        <div className="flex flex-wrap items-center gap-(--s-4) border-t border-line py-(--s-5) max-sm:gap-(--s-3)">
          <Logo />
          <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-3 p-0 max-sm:gap-x-4.5">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={footLink}>
                  {link.label}
                </Link>
              </li>
            ))}
            {EXTERNAL_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} className={footLink}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
          <small className="ml-auto text-sm text-ink-soft max-sm:ml-0 max-sm:w-full">
            MIT License · © 2026 Meenic
          </small>
        </div>
      </div>
    </footer>
  );
}
