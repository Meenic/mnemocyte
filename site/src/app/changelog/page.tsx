import type { Metadata } from "next";
import { TextLink } from "@/components/ui/text-link";
import { getChangelog } from "@/lib/changelog";
import { REPO_URL } from "@/lib/site";
import { Release } from "./_components/release";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every Mnemocyte release from 1.0, newest first.",
};

export default async function ChangelogPage() {
  const sections = await getChangelog();

  return (
    <div className="wrap">
      <header className="pt-(--page-top) pb-(--s-5)">
        <h1>Changelog</h1>
        <p className="lead mt-(--s-3) max-w-[28em]">
          Every release, newest first. Since 1.0 the documented API follows
          semantic versioning, so breaking changes wait for 2.0.
        </p>
      </header>
      <div>
        {sections.map((section, index) => (
          <Release
            key={section.kind === "release" ? section.version : section.heading}
            section={section}
            latest={index === 0}
          />
        ))}
        <div className="border-t border-line pt-(--s-4)">
          <TextLink href={`${REPO_URL}/blob/main/CHANGELOG.md`}>
            Full changelog, back to 0.1
          </TextLink>
        </div>
      </div>
    </div>
  );
}
