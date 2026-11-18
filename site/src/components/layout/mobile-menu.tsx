"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { isCurrent, NAV_LINKS, REPO_URL } from "@/lib/site";

const MENU_LINKS = [{ href: "/", label: "Home" }, ...NAV_LINKS] as const;

const link =
  "block border-b border-line py-3.5 text-menu no-underline active:bg-surface aria-[current=page]:font-semibold";

/**
 * The Menu button and the list it opens, under 720px. The list drops over
 * the page from the bottom of the sticky header. Escape closes it and
 * returns focus to the button; changing page closes it too.
 */
export function MobileMenu() {
  const pathname = usePathname();
  // The menu remembers the page it was opened on, so it closes by itself
  // when the page changes.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      button.current?.focus();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        ref={button}
        type="button"
        className={buttonClasses({ variant: "line", size: "sm" })}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpenOn(open ? null : pathname)}
      >
        {open ? "Close" : "Menu"}
      </button>
      <nav
        id="mobile-menu"
        aria-label="Mobile"
        hidden={!open}
        className="absolute inset-x-0 top-full border-t border-line bg-bg"
      >
        <ul className="px-(--gutter) pt-2 pb-5">
          {MENU_LINKS.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                className={link}
                aria-current={isCurrent(pathname, href) ? "page" : undefined}
                onClick={() => setOpenOn(null)}
              >
                {label}
              </Link>
            </li>
          ))}
          <li>
            <a href={REPO_URL} className={link}>
              GitHub
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}
