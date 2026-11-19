import { type ChangelogSection, formatDate } from "@/lib/changelog";
import { cn } from "@/lib/cn";
import { Markdown } from "./markdown";

interface ReleaseProps {
  section: ChangelogSection;
  /** The newest release: its number sits on a pink notched block. */
  latest: boolean;
}

/** One release: version and date on the left, summary and entries on the right. */
export function Release({ section, latest }: ReleaseProps) {
  const version =
    section.kind === "release" ? section.version : section.heading;

  return (
    <article className="grid grid-cols-[240px_minmax(0,1fr)] gap-(--s-4) border-t border-line py-(--s-4) first:border-ink max-lg:grid-cols-1 max-lg:gap-(--s-3)">
      <div>
        <h2
          className={cn(
            "font-mono text-lg leading-none font-semibold tracking-[-0.02em]",
            latest &&
              "-ml-2.5 inline-block bg-primary px-2.5 pt-1.5 pb-1.25 text-on-primary [clip-path:var(--notch-sm)]",
          )}
        >
          {version}
        </h2>
        {section.kind === "release" && (
          <time
            dateTime={section.date}
            className="mt-2.5 block text-ui text-ink-soft"
          >
            {formatDate(section.date)}
          </time>
        )}
      </div>
      {section.kind === "release" ? (
        <div>
          <h3 className="mb-3">
            <Markdown markdown={section.title} inline />
          </h3>
          <ul className="m-0 flex max-w-[40em] list-disc flex-col gap-2 pl-5 marker:text-ink-soft">
            {section.entries.map((entry) => (
              <li key={entry}>
                <Markdown markdown={entry} inline />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex max-w-[40em] flex-col gap-3 [&_h3]:mt-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
          <Markdown markdown={section.markdown} />
        </div>
      )}
    </article>
  );
}
