import { Colony } from "@/components/art/colony";
import { Button } from "@/components/ui/button";
import { InstallBox } from "@/components/ui/install-box";
import { REPO_URL } from "@/lib/site";

/* The pink notched card that closes the page. The on-primary class turns
   the key word pink on its ink block. */
export function ClosingCard() {
  return (
    <section className="pt-(--section)">
      <div className="wrap">
        <div className="on-primary grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-center gap-(--s-5) bg-primary px-[clamp(28px,6vw,88px)] py-[clamp(48px,7vw,96px)] text-on-primary [clip-path:var(--notch)] max-lg:grid-cols-1">
          <div>
            <h2 className="text-2xl">
              Free and <span className="key">open source</span>.
            </h2>
            <p className="mt-(--s-3) max-w-[22em] text-md leading-normal">
              MIT licensed. No accounts, no pricing, no limits. A star helps
              others find it.
            </p>
            <div className="mt-(--s-4) flex flex-wrap gap-3">
              <Button
                href={REPO_URL}
                className="hover:border-on-ink hover:bg-on-ink hover:text-ink max-sm:w-full"
              >
                Star on GitHub
              </Button>
              <InstallBox tone="onPrimary" className="max-sm:w-full" />
            </div>
          </div>
          <Colony variant="card" />
        </div>
      </div>
    </section>
  );
}
