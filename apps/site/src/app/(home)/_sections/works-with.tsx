import type { ReactNode } from "react";
import { InlineCode } from "@/components/ui/inline-code";

const INTEGRATIONS: { path: string; name: string; text: ReactNode }[] = [
  {
    path: "mnemocyte/postgres",
    name: "Postgres",
    text: "With pgvector 0.8 or later, through postgres.js, node-postgres, PGlite or Drizzle. Prototype with no database at all.",
  },
  {
    path: "mnemocyte/ai-sdk",
    name: "The AI SDK",
    text: (
      <>
        Memory tools a model can call, or <InlineCode>withMemory</InlineCode> to
        add the user’s memories to every prompt.
      </>
    ),
  },
  {
    path: "mnemocyte/embedders",
    name: "Embedders",
    text: "OpenAI, Voyage, Cohere and Gemini, any OpenAI-compatible server such as Ollama, or your own.",
  },
];

export function WorksWith() {
  return (
    <section className="pt-(--section)">
      <div className="wrap">
        <h2 className="mb-(--s-5)">
          Lives in the <span className="key">Postgres</span> you
          already&nbsp;run.
        </h2>
        <div className="grid grid-cols-3 gap-x-(--s-4) border-t border-ink max-lg:grid-cols-1 max-lg:gap-y-(--s-2)">
          {INTEGRATIONS.map(({ path, name, text }) => (
            <div key={path} className="pt-(--s-4) max-lg:pb-(--s-2)">
              <code className="text-code text-ink-soft">{path}</code>
              <h3 className="mt-(--s-2) mb-(--s-1)">{name}</h3>
              <p className="max-w-[24em] text-ink-soft">{text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
