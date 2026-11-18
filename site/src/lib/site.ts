/** Links and navigation shared by the header and footer. */

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
