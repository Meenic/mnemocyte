import type { ReactNode } from "react";
import { LifecycleIcon } from "@/components/art/lifecycle-icon";
import { InlineCode } from "@/components/ui/inline-code";
import type { GlyphKind } from "@/lib/colony/glyph";

const STAGES: { kind: GlyphKind; name: string; text: ReactNode }[] = [
  {
    kind: "add",
    name: "Add",
    text: "Save what your app learns. Give a memory a key and later saves update it in place.",
  },
  {
    kind: "recall",
    name: "Recall",
    text: "Hybrid search ranks by meaning and keywords, with newer and more important memories nudged up.",
  },
  {
    kind: "merge",
    name: "Merge",
    text: (
      <>
        <InlineCode>findDuplicates</InlineCode> spots near-identical memories
        and <InlineCode>consolidate</InlineCode> folds them into one.
      </>
    ),
  },
  {
    kind: "prune",
    name: "Prune",
    text: "Expire memories, prune what nobody used, or erase a user in one call.",
  },
];

export function LifeCycle() {
  return (
    <section className="pt-(--section)">
      <div className="wrap grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-(--split) max-lg:grid-cols-1">
        <div>
          <h2>Every memory has a life cycle.</h2>
          <p className="lead mt-(--s-3) max-w-[20em]">
            From the first save to the last prune, each step is one call you
            control.
          </p>
        </div>
        <div className="grid grid-cols-2 border-t border-ink max-sm:grid-cols-1">
          {STAGES.map(({ kind, name, text }) => (
            <div
              key={kind}
              className="border-b border-line py-(--s-4) pr-(--s-4) even:border-l even:pr-0 even:pl-(--s-4) max-sm:grid max-sm:grid-cols-[64px_1fr] max-sm:gap-x-5 max-sm:px-0 max-sm:py-7 max-sm:even:border-l-0 max-sm:even:pl-0"
            >
              <div className="mb-(--s-3) max-sm:row-span-2 max-sm:mb-0">
                <LifecycleIcon kind={kind} />
              </div>
              <h3>{name}</h3>
              <p className="mt-(--s-1) max-w-[22em] text-ink-soft">{text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
