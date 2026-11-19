import { ClosingCard } from "./_sections/closing-card";
import { CodeExample } from "./_sections/code-example";
import { Conversation } from "./_sections/conversation";
import { Hero } from "./_sections/hero";
import { LifeCycle } from "./_sections/life-cycle";
import { WorksWith } from "./_sections/works-with";

export default function HomePage() {
  return (
    <>
      <Hero />
      <CodeExample />
      <WorksWith />
      <LifeCycle />
      <Conversation />
      <ClosingCard />
    </>
  );
}
