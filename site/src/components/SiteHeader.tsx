"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isCurrent, NAV_LINKS, REPO_URL } from "@/lib/site";
import { Button, buttonClasses } from "./Button";
import { GitHubIcon } from "./GitHubIcon";
import { Logo } from "./Logo";

/* A 2px ink underline that grows on hover and stays on the current page. */
const navLink =
  "py-1.5 text-ui text-ink-soft no-underline [background:linear-gradient(var(--ink),var(--ink))_left_bottom/0_2px_no-repeat] [transition:color_.15s,background-size_.2s] hover:text-ink hover:[background-size:100%_2px] active:opacity-70 aria-[current=page]:text-ink aria-[current=page]:[background-size:100%_2px] motion-reduce:transition-none";

const menuLink =
  "block border-b border-line py-3.5 text-menu no-underline active:bg-surface aria-[current=page]:font-semibold";

/** Sticky header: logo, page links and GitHub; a Menu button under 720px. */
export function SiteHeader() {
  const pathname = usePathname();
  // The menu remembers the page it was opened on, so it closes by itself
  // when the page changes.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      menuButton.current?.focus();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [open]);

  const current = (href: string) =>
    isCurrent(pathname, href) ? "page" : undefined;

  return (
    <header className="sticky top-0 z-50 bg-bg">
      <div className="wrap flex h-(--nav-h) items-center gap-(--s-4) max-md:gap-(--s-2)">
        <Logo />
        <ul className="m-0 flex list-none gap-7 p-0 max-md:hidden">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={navLink}
                aria-current={current(link.href)}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-2.5">
          <Button
            href={REPO_URL}
            variant="line"
            size="sm"
            className="max-md:hidden"
          >
            <GitHubIcon />
            GitHub
          </Button>
          <button
            ref={menuButton}
            type="button"
            className={buttonClasses({
              variant: "line",
              size: "sm",
              className: "md:hidden",
            })}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpenOn(open ? null : pathname)}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
      <nav
        id="mobile-menu"
        aria-label="Mobile"
        hidden={!open}
        className="border-t border-line md:hidden"
      >
        <ul className="m-0 list-none px-(--gutter) pt-2 pb-5">
          {[{ href: "/", label: "Home" }, ...NAV_LINKS].map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={menuLink}
                aria-current={current(link.href)}
                onClick={() => setOpenOn(null)}
              >
                {link.label}
              </Link>
            </li>
          ))}
          <li>
            <a href={REPO_URL} className={menuLink}>
              GitHub
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}
