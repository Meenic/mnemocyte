import { Colony } from "@/components/art/colony";
import { Button } from "@/components/ui/button";
import { InstallBox } from "@/components/ui/install-box";

/* What the colony reads out when a memory is recalled. Module-level, since
   a new array on every render would restart the colony. */
const MEMORIES = [
  "Is vegetarian",
  "Runs a bakery in Porto",
  "Sister Inês lives in Lyon",
  "Prefers short, direct answers",
  "Moved to Porto in February",
  "Hates cilantro",
  "Opens at 6:30",
  "Has a dog called Bolacha",
  "Uses metric units",
  "Lives near Bolhão market",
  "Bakes sourdough on Sundays",
  "Hiring a second baker",
  "Mother’s birthday is 12 May",
  "Wants prices in euros",
  "Planning a trip to Tbilisi",
  "Drinks oat flat whites",
  "Closes on Mondays",
  "Friend Maya from university",
  "Likes a summary first",
  "Commutes by bike",
] as const;

export function Hero() {
  return (
    <section className="pt-(--page-top)">
      <div className="wrap grid grid-cols-[minmax(0,13fr)_minmax(0,10fr)] items-center gap-(--split) max-lg:grid-cols-1">
        <div className="max-w-150">
          <h1 className="max-sm:text-[min(var(--fs-2xl),9.6vw)]">
            <span className="key hang">Memory</span> for TypeScript
            AI&nbsp;apps.
          </h1>
          <p className="lead mt-(--s-3) max-w-[24em]">
            Save what your AI app learns, then pull back what matters when you
            build a prompt.
          </p>
          <div className="mt-(--s-4) flex flex-wrap gap-3">
            <InstallBox className="max-sm:w-full" />
            <Button href="/docs" arrow className="max-sm:w-full">
              Get started
            </Button>
          </div>
        </div>
        <Colony variant="hero" texts={MEMORIES} />
      </div>
    </section>
  );
}
