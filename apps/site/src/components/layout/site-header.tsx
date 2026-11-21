import { GitHubIcon } from "@/components/brand/github-icon";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { REPO_URL } from "@/lib/site";
import { MobileMenu } from "./mobile-menu";
import { NavLinks } from "./nav-links";

/** Sticky header: logo, page links and GitHub; a Menu button under 720px. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 bg-bg">
      <div className="wrap flex h-(--nav-h) items-center gap-(--s-4) max-md:gap-(--s-2)">
        <Logo />
        <NavLinks />
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
          <MobileMenu />
        </div>
      </div>
    </header>
  );
}
