/** Site-wide constants: links, navigation and the copy metadata reuses. */

export const REPO_URL = "https://github.com/Meenic/mnemocyte";
export const NPM_URL = "https://www.npmjs.com/package/mnemocyte";
export const SPONSOR_URL = "https://github.com/sponsors/Meenic";

export const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
  { href: "/community", label: "Community" },
] as const;

/** True when `href` is the current page or a page below it (/docs/api). */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The README's tagline, word for word. */
export const TAGLINE = "Memory for TypeScript AI apps.";

/** The README's first paragraph, as plain text. */
export const DESCRIPTION =
  "Mnemocyte (nee-mo-site, “memory cell”) helps your AI app remember. Save what it learns about users, agents and sessions, then pull back what matters when you build a prompt.";

/**
 * The site's own address, for absolute URLs in metadata, the sitemap and
 * robots.txt. Vercel sets VERCEL_PROJECT_PRODUCTION_URL (a host without a
 * protocol); elsewhere it is the dev server's default address. Set a
 * custom domain here once there is one.
 */
export const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";
