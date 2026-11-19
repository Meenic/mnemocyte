import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "light" | "dark";

/* A fact the assistant remembered: ink on pink in the light card, pink
   underlined text in the ink card. */
function Fact({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={
        tone === "light"
          ? "bg-primary px-1 py-px text-on-primary box-decoration-clone"
          : "text-primary underline decoration-2 underline-offset-[5px]"
      }
    >
      {children}
    </span>
  );
}

function Who({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p
      className={cn(
        "mb-3 text-sm",
        tone === "light" ? "text-ink-soft" : "text-on-ink-soft",
      )}
    >
      {children}
    </p>
  );
}

function Said({ children }: { children: ReactNode }) {
  return <p className="text-md leading-[1.6]">{children}</p>;
}

/* An illustration of what memory makes possible, not real output. */
export function Conversation() {
  return (
    <section className="pt-(--section)">
      <div className="wrap">
        <h2 className="mb-(--s-5)">
          Seven weeks later, it still <span className="key">knows her</span>.
        </h2>
        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-(--s-3) max-lg:grid-cols-1">
          <div className="border border-line bg-surface p-(--s-4) max-sm:px-5.5 max-sm:py-7">
            <Who tone="light">Ada, 3 March</Who>
            <Said>
              I’ve <Fact tone="light">gone vegetarian</Fact>, and since I{" "}
              <Fact tone="light">moved to Porto for the bakery</Fact> I barely
              cook. My <Fact tone="light">sister Inês</Fact> keeps asking for
              restaurant tips.
            </Said>
          </div>
          <div className="mt-(--s-6) bg-ink p-(--s-4) text-on-ink [clip-path:var(--notch)] max-lg:mt-0 max-sm:px-5.5 max-sm:py-7">
            <Who tone="dark">Ada, 19 April</Who>
            <Said>Inês lands on Friday. Where should we eat?</Said>
            <div className="mt-(--s-3)">
              <Who tone="dark">Assistant</Who>
            </div>
            <Said>
              For you and <Fact tone="dark">Inês</Fact>, try a{" "}
              <Fact tone="dark">vegetarian</Fact> tasting menu in Bonfim. It’s
              ten minutes from <Fact tone="dark">the bakery</Fact>, so you can
              go straight after closing.
            </Said>
          </div>
        </div>
      </div>
    </section>
  );
}
