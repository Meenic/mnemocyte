import type { Metadata } from "next";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

/*
 * The site's own 404. It also replaces Next's default one, whose inline
 * <style> paints the body black in dark mode and stays in the document
 * after a client-side navigation back to a real page.
 */
export default function NotFound() {
  return (
    <div className="wrap pt-(--page-top)">
      <h1>
        Page not <span className="key">found</span>.
      </h1>
      <p className="lead mt-(--s-3) max-w-[28em]">
        There is nothing at this address. It may have moved, or it is not
        written yet.
      </p>
      <div className="mt-(--s-4) flex flex-wrap gap-3">
        <Button href="/" arrow>
          Back home
        </Button>
        <Button href="/changelog" variant="line">
          Changelog
        </Button>
      </div>
    </div>
  );
}
