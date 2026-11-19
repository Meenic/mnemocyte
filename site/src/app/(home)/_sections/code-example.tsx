import { CodeBlock } from "@/components/ui/code-block";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";

/* The README example. Keep it in step with README.md. */
const CODE = `import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const memory = createMemory({
  namespace: "my-app",
  embedder: openaiEmbedder({
    model: "text-embedding-3-small",
  }),
});

const user = memory.for({ entityId: "user_123" });

await user.add({
  content: "Prefers short, direct answers.",
});

const context = await user.context({
  query: "How should I reply?",
});`;

export function CodeExample() {
  return (
    <section className="pt-(--section)">
      <div className="wrap">
        <div className="mb-(--s-5) max-w-155">
          <h2>Save once. Recall as a&nbsp;prompt.</h2>
          <p className="lead mt-(--s-3)">
            <InlineCode>add</InlineCode> stores what your app learns about a
            user. <InlineCode>context</InlineCode> returns the relevant memories
            as Markdown, ready for a system prompt.
          </p>
        </div>
        <div className="grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-stretch gap-(--s-3) max-lg:grid-cols-1">
          <CodeBlock code={CODE} />
          <figure className="m-0 self-center border border-line bg-surface px-8 py-(--s-4)">
            <figcaption className="mb-(--s-3) text-sm text-ink-soft">
              <code className="text-code">context</code> returns
            </figcaption>
            {/* An example of the Markdown that context() formats. */}
            <pre className="m-0 text-code leading-[1.8] whitespace-pre-wrap [overflow-wrap:anywhere]">
              <code>
                <b className="font-semibold"># Memory Context</b>
                {"\n\n"}
                <b className="font-semibold">## Relevant Memories</b>
                {"\n\n"}
                {"- kind=preference; importance=normal; score=0.464\n"}
                {"  Prefers short, direct answers."}
              </code>
            </pre>
          </figure>
        </div>
        <TextLink href="/docs" className="mt-(--s-4)">
          Read the getting started guide
        </TextLink>
      </div>
    </section>
  );
}
