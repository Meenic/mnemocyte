import { Button } from "@/components/Button";
import { InstallBox } from "@/components/InstallBox";

/* Placeholder until the home page is built. */
export default function Home() {
  return (
    <section className="wrap pt-(--page-top)">
      <h1>
        <span className="key hang">Memory</span> for TypeScript AI apps.
      </h1>
      <div className="mt-(--s-4) flex flex-wrap gap-3">
        <InstallBox className="max-sm:w-full" />
        <Button href="/docs" arrow className="max-sm:w-full">
          Get started
        </Button>
      </div>
    </section>
  );
}
