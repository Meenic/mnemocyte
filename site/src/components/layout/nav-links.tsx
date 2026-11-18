"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isCurrent, NAV_LINKS } from "@/lib/site";

/* A 2px ink underline that grows on hover and stays on the current page. */
const link =
  "py-1.5 text-ui text-ink-soft no-underline [background:linear-gradient(var(--ink),var(--ink))_left_bottom/0_2px_no-repeat] [transition:color_.15s,background-size_.2s] hover:text-ink hover:[background-size:100%_2px] active:opacity-70 aria-[current=page]:text-ink aria-[current=page]:[background-size:100%_2px] motion-reduce:transition-none";

/** The header's page links, with the current page marked. Hidden under 720px. */
export function NavLinks() {
  const pathname = usePathname();

  return (
    <ul className="flex gap-7 max-md:hidden">
      {NAV_LINKS.map(({ href, label }) => (
        <li key={href}>
          <Link
            href={href}
            className={link}
            aria-current={isCurrent(pathname, href) ? "page" : undefined}
          >
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
